"""Autonomous smoke test for the sandbox's static AST validator.

Couvre validate_code() : liste blanche d'imports/noms/attributs et la garde sur les
exposants demesures (defense en profondeur derriere le timeout du process forke).

Exécution : python test_sandbox.py
(ou, si pytest est présent : pytest test_sandbox.py)
"""

from __future__ import annotations

import sys
from pathlib import Path

# sandbox.py utilise des imports absolus (config, ...) : la racine backend doit être
# sur le path, pas seulement le dossier services/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.sandbox import validate_code  # noqa: E402


def test_rejects_huge_literal_exponent():
    for code in ["x = 9**9**9", "x = 2**5000", "x = 2**-5000"]:
        errors = validate_code(code)
        assert errors, f"{code!r} aurait dû être rejeté"
        assert any("xposant" in e or "uissance" in e for e in errors), f"{code!r} -> {errors!r}"
    print("test_rejects_huge_literal_exponent OK")


def test_accepts_reasonable_exponent():
    for code in ["x = 2**10", "x = base ** 2", "x = value ** exponent"]:
        errors = validate_code(code)
        assert not errors, f"{code!r} n'aurait pas dû être rejeté: {errors!r}"
    print("test_accepts_reasonable_exponent OK")


def test_rejects_forbidden_import():
    errors = validate_code("import os")
    assert errors, "'import os' aurait dû être rejeté"
    print("test_rejects_forbidden_import OK")


# ---------------------------------------------------------------------------
# Runner (style smoke_test_*)
# ---------------------------------------------------------------------------
def main() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
    print(f"Tous les tests passent ({len(tests)}).")


if __name__ == "__main__":
    main()
