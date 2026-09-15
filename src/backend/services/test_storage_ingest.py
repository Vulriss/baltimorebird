"""Tests de l'ingestion de fichiers volumineux par le service de stockage.

Exécution: ``python -m services.test_storage_ingest`` depuis ``src/backend``.
Couvre la prise en charge d'un fichier déjà écrit sur disque, l'application du quota avant
tout déplacement, et la cohérence entre le registre et le disque.
"""

import shutil
import tempfile
import uuid
from pathlib import Path

from services.storage import USERS_ROOT, StorageManager


def _fresh_storage(tmp_dir: Path) -> StorageManager:
    return StorageManager(db_path=tmp_dir / "users.db")


def _scratch_file(tmp_dir: Path, name: str, size: int) -> Path:
    path = tmp_dir / name
    path.write_bytes(b"\0" * size)
    return path


def test_existing_file_is_moved_and_registered() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        storage = _fresh_storage(tmp_dir)
        user_id = str(uuid.uuid4())
        source = _scratch_file(tmp_dir, "essai.mf4", 2048)

        stored = storage.store_existing_file(user_id, source, "essai.mf4", "mf4")

        assert stored.size_bytes == 2048
        assert not source.exists()
        stored_path = storage.get_file_path(stored.id, user_id)
        assert stored_path is not None and stored_path.stat().st_size == 2048
        assert [f.id for f in storage.list_files(user_id, category="mf4", include_default=False)] == [stored.id]
        assert storage.get_used_space(user_id) == 2048

        shutil.rmtree(USERS_ROOT / user_id, ignore_errors=True)


def test_quota_is_enforced_before_moving_the_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        storage = _fresh_storage(tmp_dir)
        user_id = str(uuid.uuid4())
        source = _scratch_file(tmp_dir, "trop_gros.mf4", 4096)

        conn = storage._get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO user_quotas (user_id, quota_bytes) VALUES (?, ?)", (user_id, 1024)
        )
        conn.commit()

        try:
            storage.store_existing_file(user_id, source, "trop_gros.mf4", "mf4")
            raise AssertionError("le quota aurait dû être refusé")
        except ValueError as exc:
            assert "Quota" in str(exc)

        # Le fichier source reste intact: l'appelant garde la main pour nettoyer son scratch.
        assert source.exists()
        assert storage.list_files(user_id, category="mf4", include_default=False) == []

        shutil.rmtree(USERS_ROOT / user_id, ignore_errors=True)


def test_rejected_extension_never_reaches_the_disk() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        storage = _fresh_storage(tmp_dir)
        user_id = str(uuid.uuid4())
        source = _scratch_file(tmp_dir, "brut.blf", 512)

        try:
            storage.store_existing_file(user_id, source, "brut.blf", "mf4")
            raise AssertionError("l'extension aurait dû être refusée")
        except ValueError:
            pass

        assert source.exists()
        assert not (USERS_ROOT / user_id / "mf4").exists()

        shutil.rmtree(USERS_ROOT / user_id, ignore_errors=True)


def test_deleting_a_file_frees_the_quota() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        storage = _fresh_storage(tmp_dir)
        user_id = str(uuid.uuid4())
        source = _scratch_file(tmp_dir, "essai.mf4", 4096)

        stored = storage.store_existing_file(user_id, source, "essai.mf4", "mf4")
        stored_path = storage.get_file_path(stored.id, user_id)

        assert storage.delete_file(stored.id, user_id) is True
        assert stored_path is not None and not stored_path.exists()
        assert storage.get_used_space(user_id) == 0

        shutil.rmtree(USERS_ROOT / user_id, ignore_errors=True)


if __name__ == "__main__":
    for name, case in sorted(globals().items()):
        if name.startswith("test_") and callable(case):
            case()
            print(f"OK {name}")
