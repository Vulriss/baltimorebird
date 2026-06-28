"""Ingestion de logs Vector BLF décodés via une base de communication (ARXML AUTOSAR ou DBC).

Le log BLF est converti en un fichier MF4 contenant les signaux physiques décodés, ce qui permet de
réutiliser sans modification toute la chaîne d'analyse lazy déjà construite autour d'asammdf
(LOD, prefetch, voies calculées, statistiques d'intervalle, export).

Difficultés réelles prises en charge sur les matrices OEM :
    - SECURED-I-PDU (SecOC) sans PAYLOAD-REF, qui empêchent cantools de charger l'ARXML.
    - Container I-PDU AUTOSAR, qui exigent un décodage récursif des PDU contenus.
    - PDU routés en passerelle, qui dupliquent des messages contenus sous un même header id.
    - Multiplexage, qui fait varier l'ensemble des signaux présents d'une trame à l'autre.
    - Bus multiples dans un même log, dont une partie n'est pas décrite par la base fournie.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from asammdf import MDF, Signal
from can.io.blf import BLFReader
from cantools.database import load_file as load_can_database
from cantools.database.can.database import Database
from cantools.database.can.message import Message

logger = logging.getLogger(__name__)

# Le chargeur ARXML de cantools journalise abondamment (écrasements multi-bus, tables d'énumération
# partielles). Ce bruit n'a pas d'intérêt diagnostique pour l'utilisateur final.
logging.getLogger("cantools").setLevel(logging.ERROR)

_AUTOSAR_NS = "http://autosar.org/schema/r4.0"
_FLOAT = np.float64

# Bornes d'extraction des signaux : valeurs physiques (mises à l'échelle) et numériques.
# decode_choices=False garantit des valeurs numériques exploitables en série temporelle plutôt
# que des libellés d'énumération.
_DECODE_KWARGS = {"decode_choices": False, "scaling": True, "allow_truncated": True}


@dataclass(slots=True)
class IngestionReport:
    """Synthèse quantitative et diagnostique d'une conversion BLF vers MF4."""

    total_frames: int = 0
    decoded_frames: int = 0
    unknown_frames: int = 0
    container_payloads: int = 0
    signal_count: int = 0
    group_count: int = 0
    duration_s: float = 0.0
    start_time: datetime | None = None
    dropped_secured_pdus: list[str] = field(default_factory=list)
    unknown_ids: dict[str, int] = field(default_factory=dict)
    output_path: str | None = None

    @property
    def decoded_ratio(self) -> float:
        return self.decoded_frames / self.total_frames if self.total_frames else 0.0


@dataclass(slots=True)
class _Decoded:
    """Résultat de décodage d'une trame : signaux co-occurrents partageant un même horodatage."""

    group_key: tuple[int, str, int]
    label: str
    timestamp: float
    values: dict[str, float | int]
    is_container_payload: bool = False


class ArxmlSanitizer:
    """Rend chargeable par cantools un ARXML contenant des SECURED-I-PDU sans payload.

    Ces PDU sécurisés (authentification SecOC seule, sans PAYLOAD-REF) déclenchent une assertion
    bloquante dans cantools. La correction injecte une chaîne payload minimale et vide
    (I-SIGNAL-I-PDU -> PDU-TRIGGERING -> PAYLOAD-REF) : la matrice se charge intégralement et les
    trames concernées, réellement indécodables depuis ce fichier, sont signalées comme abandonnées.
    """

    _EMPTY_PDU = "BBD_EmptySecuredPayload"
    _EMPTY_TRIGGERING = "PT_BBD_EmptySecuredPayload"

    def __init__(self, cache_dir: Path) -> None:
        self._cache_dir = cache_dir
        self._cache_dir.mkdir(parents=True, exist_ok=True)

    def sanitize(self, source: Path) -> tuple[Path, list[str]]:
        """Retourne le chemin d'un ARXML chargeable et la liste des PDU sécurisés abandonnés.

        Le résultat est mis en cache par empreinte du contenu source pour éviter de réassainir.
        """
        from lxml import etree

        digest = self._content_digest(source)
        cached = self._cache_dir / f"{digest}.arxml"
        manifest = self._cache_dir / f"{digest}.dropped"
        if cached.exists() and manifest.exists():
            cached_dropped = manifest.read_text(encoding="utf-8").split() if manifest.stat().st_size else []
            return cached, cached_dropped

        tree = etree.parse(str(source))
        root = tree.getroot()
        secured_without_payload = [
            pdu for pdu in root.findall(f".//{{{_AUTOSAR_NS}}}SECURED-I-PDU")
            if pdu.find(f"{{{_AUTOSAR_NS}}}PAYLOAD-REF") is None
        ]

        dropped: list[str] = []
        if secured_without_payload:
            empty_path = self._inject_empty_payload_chain(root)
            for pdu in secured_without_payload:
                self._attach_payload_ref(pdu, empty_path)
                dropped.append(self._short_name(pdu) or "?")

        tree.write(str(cached), xml_declaration=True, encoding="UTF-8", standalone=False)
        manifest.write_text(" ".join(dropped), encoding="utf-8")
        return cached, dropped

    def _inject_empty_payload_chain(self, root) -> str:
        """Crée un I-SIGNAL-I-PDU vide et le PDU-TRIGGERING qui le référence, puis retourne le
        chemin AUTOSAR du triggering, cible attendue par un PAYLOAD-REF."""
        from lxml import etree

        def tag(name: str) -> str:
            return f"{{{_AUTOSAR_NS}}}{name}"

        pdu_sample = root.find(f".//{tag('I-SIGNAL-I-PDU')}")
        pdus_elements = pdu_sample.getparent()
        empty = etree.SubElement(pdus_elements, tag("I-SIGNAL-I-PDU"))
        etree.SubElement(empty, tag("SHORT-NAME")).text = self._EMPTY_PDU
        etree.SubElement(empty, tag("LENGTH")).text = "0"
        empty_pdu_path = f"{self._element_path(pdus_elements.getparent())}/{self._EMPTY_PDU}"

        triggering_sample = root.find(f".//{tag('PDU-TRIGGERING')}")
        triggerings = triggering_sample.getparent()
        triggering = etree.SubElement(triggerings, tag("PDU-TRIGGERING"))
        etree.SubElement(triggering, tag("SHORT-NAME")).text = self._EMPTY_TRIGGERING
        ref = etree.SubElement(triggering, tag("I-PDU-REF"))
        ref.set("DEST", "I-SIGNAL-I-PDU")
        ref.text = empty_pdu_path
        return f"{self._element_path(triggerings.getparent())}/{self._EMPTY_TRIGGERING}"

    @staticmethod
    def _attach_payload_ref(secured_pdu, triggering_path: str) -> None:
        """Insère un PAYLOAD-REF pointant vers le triggering vide, après le FRESHNESS-PROPS-REF
        pour respecter l'ordre attendu du schéma."""
        from lxml import etree

        ref = etree.Element(f"{{{_AUTOSAR_NS}}}PAYLOAD-REF")
        ref.set("DEST", "PDU-TRIGGERING")
        ref.text = triggering_path
        freshness = secured_pdu.find(f"{{{_AUTOSAR_NS}}}FRESHNESS-PROPS-REF")
        if freshness is not None:
            freshness.addnext(ref)
        else:
            secured_pdu.append(ref)

    @staticmethod
    def _short_name(element) -> str | None:
        node = element.find(f"{{{_AUTOSAR_NS}}}SHORT-NAME")
        return node.text if node is not None else None

    @classmethod
    def _element_path(cls, element) -> str:
        parts: list[str] = []
        node = element
        while node is not None:
            name = cls._short_name(node)
            if name is not None:
                parts.append(name)
            node = node.getparent()
        return "/" + "/".join(reversed(parts))

    @staticmethod
    def _content_digest(source: Path) -> str:
        hasher = hashlib.sha1()
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                hasher.update(chunk)
        return hasher.hexdigest()[:16]


class CanDatabase:
    """Base de communication chargée et décodeur de trames CAN/CAN-FD.

    Encapsule cantools et résout les particularités d'ingestion : assainissement ARXML,
    dédoublonnage des messages contenus, recherche par identifiant et décodage uniforme des
    messages simples, multiplexés et conteneurs.
    """

    def __init__(self, database: Database, channel_bus_map: dict[int, str] | None = None) -> None:
        self._db = database
        self._channel_bus_map = channel_bus_map or {}
        self._normalize_containers()
        self._lut: dict[tuple[int, bool], Message] = {}
        for message in self._db.messages:
            self._lut.setdefault((message.frame_id, message.is_extended_frame), message)
        self._units = self._build_unit_map()

    @classmethod
    def load(cls, database_path: Path, cache_dir: Path,
             channel_bus_map: dict[int, str] | None = None) -> tuple[CanDatabase, list[str]]:
        """Charge une base ARXML ou DBC, en assainissant l'ARXML au besoin.

        Retourne la base prête à l'emploi et la liste des PDU sécurisés abandonnés.
        """
        dropped: list[str] = []
        path = database_path
        if database_path.suffix.lower() == ".arxml":
            path, dropped = ArxmlSanitizer(cache_dir).sanitize(database_path)
        database = load_can_database(str(path), strict=False)
        if not isinstance(database, Database):
            raise ValueError(f"La base {database_path.name} n'est pas une base de communication CAN")
        return cls(database, channel_bus_map), dropped

    def decode_frame(self, frame_id: int, is_extended: bool, data: bytes,
                     channel: int, timestamp: float) -> Iterator[_Decoded]:
        """Décode une trame en un ou plusieurs enregistrements de signaux.

        Un message simple ou multiplexé produit un enregistrement ; un conteneur en produit un par
        PDU contenu. Les trames dont l'identifiant est absent de la base ne produisent rien.
        """
        message = self._lut.get((frame_id, is_extended))
        if message is None:
            return
        if message.is_container:
            yield from self._decode_container(message, data, channel, timestamp)
        else:
            values = message.decode(data, **_DECODE_KWARGS)
            if isinstance(values, dict):
                yield self._make_record(channel, message.name, timestamp, values)

    def is_known(self, frame_id: int, is_extended: bool) -> bool:
        return (frame_id, is_extended) in self._lut

    def unit_of(self, signal_name: str) -> str:
        return self._units.get(signal_name, "")

    @property
    def message_count(self) -> int:
        return len(self._db.messages)

    def _decode_container(self, message: Message, data: bytes, channel: int,
                          timestamp: float) -> Iterator[_Decoded]:
        decoded = message.decode(data, decode_containers=True, **_DECODE_KWARGS)
        if not isinstance(decoded, (list, tuple)):
            return
        for contained, values in decoded:
            if not isinstance(values, dict):
                continue
            label = contained.name if hasattr(contained, "name") else f"0x{int(contained):x}"
            yield self._make_record(channel, label, timestamp, values, prefix=label,
                                    is_container_payload=True)

    def _make_record(self, channel: int, label: str, timestamp: float,
                     values: Mapping[str, object], prefix: str | None = None,
                     is_container_payload: bool = False) -> _Decoded:
        clean = {name: float(value) for name, value in values.items() if isinstance(value, (int, float))}
        if prefix is not None:
            self._units.update({f"{prefix}.{name}": self._units.get(name, "") for name in clean})
            clean = {f"{prefix}.{name}": value for name, value in clean.items()}
        signature = hash(frozenset(clean))
        bus_label = self._channel_bus_map.get(channel, f"CH{channel}")
        return _Decoded((channel, label, signature), f"{bus_label}:{label}", timestamp, clean,
                        is_container_payload)

    def _normalize_containers(self) -> None:
        """Conserve un seul message contenu par header id. Le routage passerelle duplique des PDU
        identiques entre canaux, ce qui rend le décodage de conteneur ambigu pour cantools."""
        for message in self._db.messages:
            if not message.is_container or not message.contained_messages:
                continue
            unique: dict[int, Message] = {}
            for contained in message.contained_messages:
                if contained.header_id is not None:
                    unique.setdefault(contained.header_id, contained)
            if len(unique) != len(message.contained_messages):
                message._contained_messages = list(unique.values())

    def _build_unit_map(self) -> dict[str, str]:
        units: dict[str, str] = {}
        for message in self._db.messages:
            sources = [message]
            if message.is_container and message.contained_messages:
                sources = list(message.contained_messages)
            for source in sources:
                for signal in source.signals:
                    if signal.name not in units:
                        units[signal.name] = signal.unit or ""
        return units


class SignalAccumulator:
    """Agrège les enregistrements décodés en séries temporelles, regroupées par signaux
    co-occurrents partageant un même horodatage (un groupe MF4 par ensemble co-occurrent)."""

    def __init__(self) -> None:
        self._timestamps: dict[tuple[int, str, int], list[float]] = {}
        self._values: dict[tuple[int, str, int], dict[str, list[float]]] = {}
        self._labels: dict[tuple[int, str, int], str] = {}

    def add(self, record: _Decoded) -> None:
        key = record.group_key
        timestamps = self._timestamps.get(key)
        if timestamps is None:
            timestamps = []
            self._timestamps[key] = timestamps
            self._values[key] = {name: [] for name in record.values}
            self._labels[key] = record.label
        timestamps.append(record.timestamp)
        columns = self._values[key]
        for name, value in record.values.items():
            columns[name].append(value)

    def groups(self) -> Iterator[tuple[str, np.ndarray, dict[str, np.ndarray]]]:
        """Produit, pour chaque groupe, son libellé, le master temporel et les colonnes de signaux."""
        for key, timestamps in self._timestamps.items():
            master = np.asarray(timestamps, dtype=_FLOAT)
            columns = {name: np.asarray(samples, dtype=_FLOAT)
                       for name, samples in self._values[key].items()}
            yield self._labels[key], master, columns


class BlfToMf4Converter:
    """Orchestre la conversion d'un log Vector BLF en fichier MF4 décodé."""

    def __init__(self, database: CanDatabase, dropped_secured_pdus: Iterable[str] = ()) -> None:
        self._database = database
        self._dropped = list(dropped_secured_pdus)

    def convert(self, blf_path: Path, output_path: Path) -> IngestionReport:
        report = IngestionReport(dropped_secured_pdus=self._dropped)
        accumulator = SignalAccumulator()
        unknown: dict[tuple[int, bool], int] = {}
        first_timestamp: float | None = None

        for frame in self._read_frames(blf_path):
            report.total_frames += 1
            frame_id, is_extended, data, channel, timestamp = frame
            if first_timestamp is None:
                first_timestamp = timestamp
            relative = timestamp - first_timestamp

            if not self._database.is_known(frame_id, is_extended):
                report.unknown_frames += 1
                key = (frame_id, is_extended)
                unknown[key] = unknown.get(key, 0) + 1
                continue

            decoded_any = False
            for record in self._database.decode_frame(frame_id, is_extended, data, channel, relative):
                accumulator.add(record)
                decoded_any = True
                if record.is_container_payload:
                    report.container_payloads += 1
            if decoded_any:
                report.decoded_frames += 1

        report.start_time = (datetime.fromtimestamp(first_timestamp, tz=timezone.utc)
                             if first_timestamp is not None else None)
        report.unknown_ids = {f"0x{fid:x}{'x' if ext else ''}": count
                              for (fid, ext), count in sorted(unknown.items(),
                              key=lambda item: item[1], reverse=True)}
        self._write_mf4(accumulator, output_path, report)
        report.output_path = str(output_path)
        return report

    def _read_frames(self, blf_path: Path) -> Iterator[tuple[int, bool, bytes, int, float]]:
        with BLFReader(str(blf_path)) as reader:
            for message in reader:
                if message.is_error_frame or message.is_remote_frame:
                    continue
                channel = message.channel if isinstance(message.channel, int) else 0
                yield (message.arbitration_id, bool(message.is_extended_id),
                       bytes(message.data), channel, float(message.timestamp))

    def _write_mf4(self, accumulator: SignalAccumulator, output_path: Path,
                   report: IngestionReport) -> None:
        mdf = MDF()
        allocated: set[str] = set()
        signal_total = 0
        for label, master, columns in sorted(accumulator.groups(), key=lambda group: group[0]):
            if master.size == 0:
                continue
            bus_prefix = label.split(":", 1)[0]
            signals = [
                Signal(samples=samples, timestamps=master,
                       name=self._allocate_name(name, bus_prefix, allocated),
                       unit=self._database.unit_of(name), comment=label)
                for name, samples in columns.items()
            ]
            mdf.append(signals, comment=label)
            signal_total += len(signals)
            report.group_count += 1

        if report.start_time is not None:
            mdf.header.start_time = report.start_time
        report.signal_count = signal_total
        output_path.parent.mkdir(parents=True, exist_ok=True)
        mdf.save(str(output_path), overwrite=True)
        mdf.close()

    @staticmethod
    def _allocate_name(name: str, bus_prefix: str, allocated: set[str]) -> str:
        """Attribue un nom de voie unique : nom nu si possible, sinon préfixé par le bus, sinon
        suffixé numériquement. Préserve la lisibilité du cas courant tout en garantissant l'unicité
        que requiert l'accès par nom de la chaîne d'analyse."""
        candidate = name
        if candidate in allocated:
            candidate = f"{bus_prefix}_{name}"
        if candidate in allocated:
            base = candidate
            index = 2
            while f"{base}_{index}" in allocated:
                index += 1
            candidate = f"{base}_{index}"
        allocated.add(candidate)
        return candidate


def convert_blf_to_mf4(blf_path: str | Path, database_path: str | Path, output_path: str | Path,
                       cache_dir: str | Path | None = None,
                       channel_bus_map: dict[int, str] | None = None) -> IngestionReport:
    """Convertit un log Vector BLF en MF4 décodé à l'aide d'une base ARXML ou DBC.

    Point d'entrée destiné à la couche Flask. Le MF4 produit est consommable tel quel par la
    session d'analyse lazy existante.
    """
    blf = Path(blf_path)
    database_file = Path(database_path)
    output = Path(output_path)
    cache = Path(cache_dir) if cache_dir is not None else output.parent / ".arxml_cache"

    database, dropped = CanDatabase.load(database_file, cache, channel_bus_map)
    converter = BlfToMf4Converter(database, dropped)
    import time

    started = time.perf_counter()
    report = converter.convert(blf, output)
    report.duration_s = time.perf_counter() - started
    logger.info("BLF converti: %d/%d trames decodees (%.1f%%), %d signaux, %d groupes en %.1fs",
                report.decoded_frames, report.total_frames, 100 * report.decoded_ratio,
                report.signal_count, report.group_count, report.duration_s)
    return report
