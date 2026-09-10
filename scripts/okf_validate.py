#!/usr/bin/env python3
"""Validation d'un bundle Open Knowledge Format v0.2.

Vérifie les exigences dures de la spécification, puis des règles d'hygiène qui
ne sont pas normatives mais font la différence entre un bundle utile et un
bundle qui pourrit en silence.

Exigences dures (échec) :
    - chaque fichier .md non réservé porte un frontmatter YAML analysable ;
    - chaque frontmatter porte un ``type`` non vide ;
    - seul l'``index.md`` racine peut porter un frontmatter, et il déclare
      ``okf_version`` ;
    - aucun concept n'utilise un nom de fichier réservé.

Hygiène (avertissement, ou échec avec --strict) :
    - liens internes cassés ;
    - concepts orphelins, c'est-à-dire cités par aucun autre ;
    - champs recommandés absents.

Le parseur YAML couvre le sous-ensemble utilisé par la spécification : paires
clé/valeur, listes en ligne, blocs imbriqués et listes de blocs. Cela évite
d'imposer PyYAML à la chaîne d'intégration continue.

Usage:
    python3 scripts/okf_validate.py .okf
    python3 scripts/okf_validate.py .okf --strict
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

RESERVED_FILENAMES = {"index.md", "log.md"}
RECOMMENDED_KEYS = ("title", "description")
LINK_PATTERN = re.compile(r"\[[^\]]*\]\((/[^)\s]+)\)")
FRONTMATTER_PATTERN = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)


class Finding:
    """Constat de validation rattaché à un fichier."""

    def __init__(self, path: Path, message: str, fatal: bool) -> None:
        self.path = path
        self.message = message
        self.fatal = fatal

    def __str__(self) -> str:
        marker = "ERREUR" if self.fatal else "AVERTISSEMENT"
        return f"{marker}: {self.path}: {self.message}"


def parse_scalar(raw: str) -> Any:
    """Convertit un scalaire YAML en valeur Python."""
    value = raw.strip()
    if value.startswith(("'", '"')) and value.endswith(("'", '"')) and len(value) >= 2:
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        return [parse_scalar(item) for item in inner.split(",")] if inner else []
    return value


def parse_frontmatter(text: str) -> Tuple[Dict[str, Any], bool]:
    """Analyse le frontmatter d'un document.

    Returns:
        Le mapping analysé et un booléen indiquant la présence d'un bloc.
    """
    match = FRONTMATTER_PATTERN.match(text)
    if not match:
        return {}, False

    result: Dict[str, Any] = {}
    # Pile des conteneurs ouverts, indexée par niveau d'indentation.
    stack: List[Tuple[int, Dict[str, Any]]] = [(-1, result)]

    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue

        indent = len(line) - len(line.lstrip())
        stripped = line.strip()

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        container = stack[-1][1]

        if stripped.startswith("- "):
            item = stripped[2:].strip()
            key = next(reversed(container)) if container else None
            bucket = container.get(key) if key else None
            if not isinstance(bucket, list):
                continue
            if ":" in item:
                name, value = item.split(":", 1)
                bucket.append({name.strip(): parse_scalar(value)})
            else:
                bucket.append(parse_scalar(item))
            continue

        if ":" not in stripped:
            continue

        key, value = stripped.split(":", 1)
        key = key.strip()
        if not value.strip():
            # Bloc imbriqué ou liste : on ne sait pas encore, on ouvre un mapping
            # et une liste vide sous le même nom, la première ligne fille tranche.
            child: Dict[str, Any] = {}
            container[key] = child
            stack.append((indent, child))
            container[key] = child
        else:
            container[key] = parse_scalar(value)

    return result, True


def normalize_list_blocks(text: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Remplace par une liste les clés dont les enfants sont des tirets."""
    for key in list(data):
        pattern = re.compile(rf"^\s*{re.escape(key)}:\s*$\r?\n(\s*)-", re.MULTILINE)
        if isinstance(data[key], dict) and not data[key] and pattern.search(text):
            data[key] = []
    return data


def scalar(data: Dict[str, Any], key: str) -> str:
    """Valeur scalaire d'une clé, vide si la clé porte un bloc ou une liste.

    Une clé sans valeur (``type:``) est analysée comme un conteneur vide. La
    tester par ``str()`` la ferait passer pour renseignée, ce qui laisserait
    passer exactement la faute que la spécification interdit.
    """
    value = data.get(key)
    return value.strip() if isinstance(value, str) else ""


def collect_documents(bundle: Path) -> List[Path]:
    """Liste les fichiers markdown du bundle, chemins triés."""
    return sorted(p for p in bundle.rglob("*.md") if p.is_file())


def concept_id(bundle: Path, path: Path) -> str:
    """Identifiant d'un concept : chemin dans le bundle, sans extension."""
    return "/" + path.relative_to(bundle).as_posix()


def validate(bundle: Path, strict: bool) -> List[Finding]:
    """Valide un bundle et retourne tous les constats."""
    findings: List[Finding] = []
    documents = collect_documents(bundle)

    if not documents:
        return [Finding(bundle, "aucun fichier markdown trouvé", True)]

    root_index = bundle / "index.md"
    if not root_index.exists():
        findings.append(Finding(root_index, "index.md racine absent", False))

    known_ids = {concept_id(bundle, path) for path in documents}
    referenced: set = set()

    for path in documents:
        text = path.read_text(encoding="utf-8")
        relative = path.relative_to(bundle)
        is_reserved = relative.name in RESERVED_FILENAMES
        is_root_index = relative.as_posix() == "index.md"

        data, has_block = parse_frontmatter(text)
        data = normalize_list_blocks(text, data)

        if is_reserved and not is_root_index:
            if has_block:
                findings.append(Finding(path, "un fichier réservé ne porte pas de frontmatter", True))
        elif is_root_index:
            if has_block and not scalar(data, "okf_version"):
                findings.append(Finding(path, "l'index racine ne déclare pas okf_version", False))
        else:
            if not has_block:
                findings.append(Finding(path, "frontmatter absent ou non analysable", True))
            elif not scalar(data, "type"):
                findings.append(Finding(path, "champ type absent ou vide", True))
            else:
                missing = [key for key in RECOMMENDED_KEYS if not scalar(data, key)]
                if missing:
                    findings.append(Finding(path, f"champs recommandés absents : {', '.join(missing)}", False))

        for target in LINK_PATTERN.findall(text):
            referenced.add(target)
            if target not in known_ids:
                findings.append(Finding(path, f"lien interne cassé : {target}", False))

    for path in documents:
        identifier = concept_id(bundle, path)
        if path.name in RESERVED_FILENAMES:
            continue
        if identifier not in referenced:
            findings.append(Finding(path, "concept orphelin : cité par aucun autre document", False))

    if strict:
        for finding in findings:
            finding.fatal = True

    return findings


def main() -> int:
    """Point d'entrée en ligne de commande."""
    parser = argparse.ArgumentParser(description="Valide un bundle OKF v0.2.")
    parser.add_argument("bundle", nargs="?", default=".okf", help="Chemin du bundle (défaut : .okf)")
    parser.add_argument("--strict", action="store_true", help="Traite les avertissements comme des erreurs")
    args = parser.parse_args()

    bundle = Path(args.bundle)
    if not bundle.is_dir():
        print(f"ERREUR: bundle introuvable : {bundle}", file=sys.stderr)
        return 2

    findings = validate(bundle, args.strict)
    fatal = [finding for finding in findings if finding.fatal]

    for finding in findings:
        print(str(finding), file=sys.stderr if finding.fatal else sys.stdout)

    total = len(collect_documents(bundle))
    print(f"\n{total} documents, {len(fatal)} erreurs, {len(findings) - len(fatal)} avertissements")
    return 1 if fatal else 0


if __name__ == "__main__":
    sys.exit(main())
