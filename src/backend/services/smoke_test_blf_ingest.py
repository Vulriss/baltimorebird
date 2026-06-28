"""Test de fumée autonome de l'ingestion BLF.

Ne dépend d'aucun fichier externe : une base DBC et un log BLF synthétiques sont fabriqués à la
volée, puis convertis et vérifiés. L'assainisseur SecOC est testé sur un fragment ARXML minimal.
Exécution : python smoke_test_blf_ingest.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import can
import numpy as np
from asammdf import MDF

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blf_ingest import ArxmlSanitizer, convert_blf_to_mf4  # noqa: E402

_DBC = """\
VERSION ""
BS_:
BU_: ECU
BO_ 256 EngineStatus: 8 ECU
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16000] "rpm" ECU
 SG_ CoolantTemp : 16|8@1+ (1,-40) [-40|215] "degC" ECU
BO_ 512 MuxFrame: 8 ECU
 SG_ Selector M : 0|8@1+ (1,0) [0|255] "" ECU
 SG_ VoltageA m0 : 8|16@1+ (0.01,0) [0|655] "V" ECU
 SG_ CurrentB m1 : 8|16@1+ (0.1,0) [0|6553] "A" ECU
"""

_SECURED_ARXML = """\
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AUTOSAR xmlns="http://autosar.org/schema/r4.0">
  <AR-PACKAGES>
    <AR-PACKAGE><SHORT-NAME>PDUs</SHORT-NAME><ELEMENTS>
      <I-SIGNAL-I-PDU><SHORT-NAME>RealPdu</SHORT-NAME><LENGTH>8</LENGTH></I-SIGNAL-I-PDU>
      <SECURED-I-PDU><SHORT-NAME>OrphanSecuredPdu</SHORT-NAME><LENGTH>16</LENGTH>
        <FRESHNESS-PROPS-REF DEST="SECURE-COMMUNICATION-FRESHNESS-PROPS">/x</FRESHNESS-PROPS-REF>
      </SECURED-I-PDU>
    </ELEMENTS></AR-PACKAGE>
    <AR-PACKAGE><SHORT-NAME>Topology</SHORT-NAME><ELEMENTS>
      <PDU-TRIGGERING><SHORT-NAME>PT_RealPdu</SHORT-NAME>
        <I-PDU-REF DEST="I-SIGNAL-I-PDU">/PDUs/RealPdu</I-PDU-REF>
      </PDU-TRIGGERING>
    </ELEMENTS></AR-PACKAGE>
  </AR-PACKAGES>
</AUTOSAR>
"""


def _write_blf(path: Path) -> None:
    writer = can.io.blf.BLFWriter(str(path))
    base = 1_700_000_000.0
    for step in range(20):
        timestamp = base + step * 0.01
        writer.on_message_received(can.Message(
            timestamp=timestamp, arbitration_id=0x100, channel=1,
            data=bytes([0x40, 0x1F, 0x55, 0, 0, 0, 0, 0]), is_extended_id=False))
        selector = step % 2
        writer.on_message_received(can.Message(
            timestamp=timestamp + 0.001, arbitration_id=0x200, channel=1,
            data=bytes([selector, 0x10, 0x27, 0, 0, 0, 0, 0]), is_extended_id=False))
        writer.on_message_received(can.Message(
            timestamp=timestamp + 0.002, arbitration_id=0x7FF, channel=2,
            data=bytes(8), is_extended_id=False))  # identifiant absent de la base
    writer.stop()


def test_conversion(workdir: Path) -> None:
    dbc = workdir / "matrix.dbc"
    dbc.write_text(_DBC, encoding="utf-8")
    blf = workdir / "log.blf"
    _write_blf(blf)
    output = workdir / "decoded.mf4"

    report = convert_blf_to_mf4(blf, dbc, output, cache_dir=workdir / "cache")

    assert report.total_frames == 60, report.total_frames
    assert report.decoded_frames == 40, report.decoded_frames  # 0x100 et 0x200, pas 0x7FF
    assert report.unknown_frames == 20, report.unknown_frames
    assert "0x7ff" in report.unknown_ids, report.unknown_ids

    mdf = MDF(str(output))
    try:
        names = [ch.name for group in mdf.groups for ch in group.channels if ch.name not in ("time", "t")]
        assert len(names) == len(set(names)), f"noms dupliques: {names}"

        engine = mdf.get("EngineSpeed")
        assert engine.unit == "rpm", engine.unit
        assert np.isclose(engine.samples[0], 0x1F40 * 0.25), engine.samples[0]
        assert engine.timestamps.size == 20, engine.timestamps.size
        assert engine.timestamps[0] >= 0.0 and engine.timestamps[-1] < 1.0

        # Le multiplexage scinde le signal selon le sélecteur : deux séries de 10 points.
        assert mdf.get("VoltageA").timestamps.size == 10, mdf.get("VoltageA").timestamps.size
        assert mdf.get("CurrentB").timestamps.size == 10, mdf.get("CurrentB").timestamps.size
    finally:
        mdf.close()
    print("test_conversion OK")


def test_secured_sanitizer(workdir: Path) -> None:
    import cantools
    from lxml import etree

    source = workdir / "secured.arxml"
    source.write_text(_SECURED_ARXML, encoding="utf-8")

    sanitized, dropped = ArxmlSanitizer(workdir / "cache").sanitize(source)
    assert dropped == ["OrphanSecuredPdu"], dropped

    tree = etree.parse(str(sanitized))
    ns = {"a": "http://autosar.org/schema/r4.0"}
    orphan = next(pdu for pdu in tree.findall(".//a:SECURED-I-PDU", ns)
                  if pdu.find("a:SHORT-NAME", ns).text == "OrphanSecuredPdu")
    assert orphan.find("a:PAYLOAD-REF", ns) is not None, "PAYLOAD-REF non injecté"

    cantools.database.load_file(str(sanitized), strict=False)  # doit charger sans lever
    print("test_secured_sanitizer OK")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        test_conversion(workdir)
        test_secured_sanitizer(workdir)
    print("Tous les tests passent.")


if __name__ == "__main__":
    main()
