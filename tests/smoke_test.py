"""
Baltimore Bird - Smoke test end-to-end.

Verifie le parcours critique de l'application contre un serveur en cours d'execution :
authentification, stockage, EDA lazy et controle d'acces de /api/view.

Usage :
    1. Demarrer le backend : python src/backend/server.py
    2. Lancer le test :      python tests/smoke_test.py [--base-url http://localhost:5000]

Dependances : requests (pip install -r tests/requirements-dev.txt)

Le script retourne un code de sortie 0 si tous les tests passent, 1 sinon.
Chaque execution cree deux comptes jetables horodates ; la base de test peut etre
reinitialisee en supprimant src/backend/data/auth/users.db.
"""

import argparse
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import requests

BACKEND_DIR = Path(__file__).resolve().parent.parent / "src" / "backend"
DEMO_MF4 = BACKEND_DIR / "data" / "default" / "mf4" / "00000002.mf4"
DEMO_DBC = BACKEND_DIR / "data" / "default" / "dbc" / "11-bit-OBD2-v4.0.dbc"

PASSWORD = "SmokeTest!12345"


class SmokeTestError(AssertionError):
    """Echec d'une etape du smoke test."""


class SmokeTestRunner:
    """Execute les verifications end-to-end contre un serveur Baltimore Bird."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.passed = 0
        self.failed = 0

    def check(self, label: str, condition: bool, detail: str = "") -> None:
        if condition:
            self.passed += 1
            print(f"  [PASS] {label}")
        else:
            self.failed += 1
            print(f"  [FAIL] {label}" + (f" -- {detail}" if detail else ""))

    def url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    @staticmethod
    def bearer(token: str) -> Dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    def register(self, label: str) -> Dict[str, Any]:
        email = f"smoke-{label}-{uuid.uuid4().hex[:8]}@test.local"
        res = requests.post(
            self.url("/api/auth/register"),
            json={"email": email, "password": PASSWORD},
            timeout=10,
        )
        if res.status_code != 201:
            raise SmokeTestError(f"Inscription impossible ({res.status_code}): {res.text[:200]}")
        return res.json()

    def run(self) -> int:
        print(f"Baltimore Bird smoke test -- {self.base_url}\n")

        self.test_health()
        alice = self.register("alice")
        bob = self.register("bob")
        self.test_auth(alice["token"])
        self.test_storage_upload(alice["token"])
        session_id = self.test_lazy_source_flow(alice["token"])
        self.test_view_access_control(alice["token"], bob["token"], session_id)
        self.test_eda_upload(alice["token"])
        self.test_anonymous_flow(alice["token"])

        print(f"\nResultat: {self.passed} OK, {self.failed} KO")
        return 0 if self.failed == 0 else 1

    def test_health(self) -> None:
        print("[1] Sante du serveur")
        res = requests.get(self.url("/health"), timeout=10)
        self.check("GET /health -> 200", res.status_code == 200, res.text[:100])
        self.check("Datastore demo charge", res.json().get("loaded") is True)

    def test_auth(self, token: str) -> None:
        print("[2] Authentification")
        res = requests.get(self.url("/api/auth/me"), headers=self.bearer(token), timeout=10)
        self.check("GET /api/auth/me avec token -> 200", res.status_code == 200, res.text[:100])

        res = requests.get(self.url("/api/auth/me"), timeout=10)
        self.check("GET /api/auth/me anonyme -> 401", res.status_code == 401, f"recu {res.status_code}")

        res = requests.post(
            self.url("/api/auth/login"),
            json={"email": "smoke-nobody@test.local", "password": "WrongPass!123"},
            timeout=10,
        )
        self.check("Login identifiants invalides -> 401", res.status_code == 401, f"recu {res.status_code}")

    def test_storage_upload(self, token: str) -> None:
        print("[3] Stockage utilisateur")
        headers = self.bearer(token)

        with DEMO_MF4.open("rb") as fh:
            res = requests.post(
                self.url("/api/storage/files/mf4"),
                headers=headers,
                files={"file": ("smoke_test_AMP.mf4", fh)},
                data={"description": "smoke test"},
                timeout=60,
            )
        self.check("Upload mf4 (nom avec underscores) -> 201", res.status_code == 201, res.text[:200])

        with DEMO_DBC.open("rb") as fh:
            res = requests.post(
                self.url("/api/storage/files/dbc"),
                headers=headers,
                files={"file": ("smoke_obd2.dbc", fh)},
                timeout=30,
            )
        self.check("Upload dbc -> 201", res.status_code == 201, res.text[:200])

        long_name = "05-12-2025_DZ110Entry_VC827_A212_0100H_D149_0212_VC_1_PVALs_AU-PT_PTM01_Test1_NORMAL_" \
            + "x" * 40 + ".mf4"
        with DEMO_MF4.open("rb") as fh:
            res = requests.post(
                self.url("/api/storage/files/mf4"),
                headers=headers,
                files={"file": (long_name, fh)},
                timeout=60,
            )
        self.check(
            "Upload mf4 nom tres long (>120 car.) -> 201 (limite MAX_PATH Windows)",
            res.status_code == 201,
            res.text[:200],
        )

        res = requests.post(
            self.url("/api/storage/files/mf4"),
            headers=headers,
            files={"file": ("notes.txt", b"not an mf4")},
            timeout=10,
        )
        self.check("Extension invalide -> 400", res.status_code == 400, f"recu {res.status_code}")

        res = requests.post(
            self.url("/api/storage/files/mf4"),
            files={"file": ("anon.mf4", b"data")},
            timeout=10,
        )
        self.check("Upload anonyme -> 401", res.status_code == 401, f"recu {res.status_code}")

    def test_lazy_source_flow(self, token: str) -> Optional[str]:
        print("[4] Source lazy EDA (fichier utilisateur)")
        headers = self.bearer(token)

        res = requests.get(self.url("/api/sources"), headers=headers, timeout=10)
        self.check("GET /api/sources -> 200", res.status_code == 200, res.text[:100])
        user_sources = [s for s in res.json().get("sources", []) if s.get("category") == "user"]
        self.check("Fichier uploade visible dans les sources", len(user_sources) >= 1)
        if not user_sources:
            return None

        source_id = user_sources[0]["id"]
        res = requests.post(self.url(f"/api/source/{source_id}"), headers=headers, timeout=120)
        self.check(f"POST /api/source/{source_id} -> 200", res.status_code == 200, res.text[:200])
        if res.status_code != 200:
            return None

        payload = res.json()
        session_id = payload.get("session_id", "")
        self.check("session_id retourne (stem avec underscores)", "_" in session_id, session_id)
        self.check("Signaux listes", payload.get("n_signals", 0) > 0)

        res = requests.post(
            self.url(f"/api/eda/preload-signal/{session_id}/0"),
            headers=headers,
            timeout=60,
        )
        self.check("Preload signal sur session a underscores -> 200", res.status_code == 200, res.text[:200])
        return session_id

    def test_view_access_control(self, owner_token: str, other_token: str, session_id: Optional[str]) -> None:
        print("[5] Controle d'acces /api/view")

        res = requests.get(self.url("/api/view?signals=0"), timeout=30)
        self.check("Vue demo anonyme (sans session_id) -> 200", res.status_code == 200, res.text[:100])

        if not session_id:
            self.check("Session lazy disponible pour le test d'acces", False, "etape [4] incomplete")
            return

        view_url = self.url(f"/api/view?session_id={session_id}&signals=0,1,2,3")

        res = requests.get(view_url, timeout=30)
        self.check("Session lazy anonyme -> 401", res.status_code == 401, f"recu {res.status_code}")

        res = requests.get(view_url, headers=self.bearer(other_token), timeout=30)
        self.check("Session lazy d'un autre utilisateur -> 403", res.status_code == 403, f"recu {res.status_code}")

        deadline = time.time() + 30
        status, body = 0, ""
        while time.time() < deadline:
            res = requests.get(view_url, headers=self.bearer(owner_token), timeout=60)
            status, body = res.status_code, res.text[:200]
            if status == 200:
                break
            time.sleep(1)
        self.check("Session lazy du proprietaire -> 200", status == 200, body)
        if status == 200:
            self.check("Donnees de signaux retournees", len(res.json().get("signals", [])) > 0)

    def test_eda_upload(self, token: str) -> None:
        print("[6] Upload Interactive EDA")

        with DEMO_MF4.open("rb") as fh:
            res = requests.post(self.url("/api/eda/upload"), files={"file": ("anon.mf4", fh)}, timeout=30)
        self.check(
            "Upload EDA anonyme accepte en mode ephemere",
            res.status_code == 200 and res.json().get("ephemeral") is True,
            f"recu {res.status_code}: {res.text[:120]}",
        )

        long_eda_name = "smoke_eda_" + "y" * 110 + ".mf4"
        with DEMO_MF4.open("rb") as mf4, DEMO_DBC.open("rb") as dbc:
            res = requests.post(
                self.url("/api/eda/upload"),
                headers=self.bearer(token),
                files={"file": (long_eda_name, mf4), "dbc": ("smoke_eda.dbc", dbc)},
                timeout=120,
            )
        self.check("Upload EDA authentifie (nom tres long) -> 200", res.status_code == 200, res.text[:200])
        if res.status_code != 200:
            return

        session_id = res.json().get("session_id", "")
        res = requests.get(
            self.url(f"/api/eda/list-signals/{session_id}"),
            headers=self.bearer(token),
            timeout=120,
        )
        self.check("Listing des signaux de la session EDA -> 200", res.status_code == 200, res.text[:200])
        if res.status_code != 200:
            return

        n_signals = res.json().get("n_signals", 0)
        self.check("Session EDA avec signaux", n_signals > 0, str(n_signals))
        if n_signals == 0:
            return

        res = requests.post(
            self.url(f"/api/eda/preload-signal/{session_id}/{n_signals - 1}"),
            headers=self.bearer(token),
            timeout=60,
        )
        self.check(
            "Preload du dernier indice valide -> 200 (pas de plafond arbitraire)",
            res.status_code == 200,
            f"recu {res.status_code}: {res.text[:150]}",
        )

        res = requests.post(
            self.url(f"/api/eda/preload-signal/{session_id}/{n_signals}"),
            headers=self.bearer(token),
            timeout=30,
        )
        self.check("Preload d'un indice hors limites -> 404", res.status_code == 404, f"recu {res.status_code}")

    def test_anonymous_flow(self, owner_token: str) -> None:
        print("[7] Parcours utilisateur anonyme")

        res = requests.post(self.url("/api/source/synthetic"), timeout=60)
        self.check("Source demo synthetic sans token -> 200", res.status_code == 200, res.text[:150])
        res = requests.post(self.url("/api/source/mf4"), timeout=60)
        self.check("Source demo mf4 sans token -> 200", res.status_code == 200, res.text[:150])

        with DEMO_MF4.open("rb") as mf4, DEMO_DBC.open("rb") as dbc:
            res = requests.post(
                self.url("/api/eda/upload"),
                files={"file": ("anon_session.mf4", mf4), "dbc": ("anon_session.dbc", dbc)},
                timeout=120,
            )
        self.check("Upload EDA anonyme -> 200 (fichier temporaire)", res.status_code == 200, res.text[:200])
        if res.status_code != 200:
            return

        payload = res.json()
        self.check("Session marquee ephemeral", payload.get("ephemeral") is True, str(payload)[:150])
        session_id = payload.get("session_id", "")

        res = requests.get(self.url(f"/api/eda/list-signals/{session_id}"), timeout=120)
        self.check("Listing anonyme de sa session -> 200", res.status_code == 200, res.text[:150])

        res = requests.get(self.url(f"/api/view?session_id={session_id}&signals=3"), timeout=60)
        self.check("Vue anonyme de sa session -> 200", res.status_code == 200, res.text[:150])

        res = requests.delete(self.url(f"/api/eda/session/{session_id}"), timeout=30)
        self.check("Fermeture de la session anonyme -> 200", res.status_code == 200, res.text[:150])

        res = requests.get(self.url(f"/api/eda/list-signals/{session_id}"), timeout=30)
        self.check("Session fermee inaccessible -> 404", res.status_code == 404, f"recu {res.status_code}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test end-to-end Baltimore Bird")
    parser.add_argument("--base-url", default="http://localhost:5000", help="URL du backend a tester")
    args = parser.parse_args()

    if not DEMO_MF4.exists() or not DEMO_DBC.exists():
        print(f"Fichiers de demo introuvables sous {BACKEND_DIR / 'data' / 'default'}")
        return 1

    try:
        return SmokeTestRunner(args.base_url).run()
    except requests.ConnectionError:
        print(f"Connexion impossible a {args.base_url}. Le serveur est-il demarre ?")
        return 1
    except SmokeTestError as exc:
        print(f"Echec bloquant: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
