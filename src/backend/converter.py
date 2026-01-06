"""
Oriole - File Conversion Module
Handles conversion between automotive data formats (MF4, CSV, MAT, etc.)
"""
import os
import uuid
import time
import threading
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, Dict, Any
from enum import Enum

import numpy as np


class ConversionStatus(Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class ConversionTask:
    """Représente une tâche de conversion"""
    id: str
    input_file: Path
    output_format: str
    dbc_file: Optional[Path] = None
    resample_raster: Optional[str] = None  # Pour MF4→CSV: '0.01', '0.1', '1', 'original'
    status: ConversionStatus = ConversionStatus.PENDING
    progress: float = 0.0
    message: str = ""
    output_file: Optional[Path] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None


class ConversionManager:
    """Gère les tâches de conversion"""
    
    def __init__(self, temp_dir: Path):
        self.temp_dir = temp_dir
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.tasks: Dict[str, ConversionTask] = {}
        self._lock = threading.Lock()
    
    def create_task(self, input_file: Path, output_format: str, dbc_file: Optional[Path] = None, resample_raster: Optional[str] = None) -> ConversionTask:
        """Crée une nouvelle tâche de conversion"""
        task_id = str(uuid.uuid4())[:8]
        task = ConversionTask(
            id=task_id,
            input_file=input_file,
            output_format=output_format,
            dbc_file=dbc_file,
            resample_raster=resample_raster
        )
        
        with self._lock:
            self.tasks[task_id] = task
        
        return task
    
    def get_task(self, task_id: str) -> Optional[ConversionTask]:
        """Récupère une tâche par son ID"""
        return self.tasks.get(task_id)
    
    def update_task(self, task_id: str, **kwargs):
        """Met à jour une tâche"""
        with self._lock:
            task = self.tasks.get(task_id)
            if task:
                for key, value in kwargs.items():
                    if hasattr(task, key):
                        setattr(task, key, value)
    
    def cleanup_old_tasks(self, max_age_hours: int = 24):
        """Nettoie les anciennes tâches et leurs fichiers"""
        now = time.time()
        max_age_seconds = max_age_hours * 3600
        
        with self._lock:
            to_delete = []
            for task_id, task in self.tasks.items():
                if now - task.created_at > max_age_seconds:
                    # Supprime les fichiers associés
                    if task.input_file and task.input_file.exists():
                        try:
                            task.input_file.unlink()
                        except:
                            pass
                    if task.output_file and task.output_file.exists():
                        try:
                            task.output_file.unlink()
                        except:
                            pass
                    if task.dbc_file and task.dbc_file.exists():
                        try:
                            task.dbc_file.unlink()
                        except:
                            pass
                    to_delete.append(task_id)
            
            for task_id in to_delete:
                del self.tasks[task_id]
        
        return len(to_delete)
    
    def run_conversion(self, task_id: str):
        """Lance la conversion dans un thread séparé"""
        task = self.get_task(task_id)
        if not task:
            return
        
        thread = threading.Thread(target=self._execute_conversion, args=(task_id,))
        thread.daemon = True
        thread.start()
    
    def _execute_conversion(self, task_id: str):
        """Exécute la conversion (appelé dans un thread)"""
        task = self.get_task(task_id)
        if not task:
            return
        
        try:
            self.update_task(task_id, status=ConversionStatus.PROCESSING, progress=0.0, message="Démarrage...")
            
            input_ext = task.input_file.suffix.lower()
            output_format = task.output_format.lower()
            
            # Dispatch vers la bonne fonction de conversion
            if input_ext == '.mf4' and output_format == 'csv':
                self._convert_mf4_to_csv(task)
            else:
                raise ValueError(f"Conversion {input_ext} → .{output_format} non supportée")
            
            self.update_task(
                task_id,
                status=ConversionStatus.COMPLETED,
                progress=100.0,
                message="Conversion terminée",
                completed_at=time.time()
            )
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.update_task(
                task_id,
                status=ConversionStatus.FAILED,
                error=str(e),
                message=f"Erreur: {str(e)}"
            )
    
    def _convert_mf4_to_csv(self, task: ConversionTask):
        """
        Convertit un fichier MF4 en CSV
        
        APPROCHE OPTIMISÉE: Utilise mdf.resample() natif puis to_dataframe()
        C'est beaucoup plus rapide que l'interpolation manuelle!
        """
        from asammdf import MDF
        
        self.update_task(task.id, progress=5.0, message="Ouverture du fichier MF4...")
        
        output_filename = task.input_file.stem + '.csv'
        output_path = self.temp_dir / output_filename
        
        # Parse le raster
        raster = None
        if task.resample_raster and task.resample_raster != 'original':
            raster = float(task.resample_raster)
        
        print(f"  → Opening MF4: {task.input_file.name}")
        mdf = MDF(task.input_file)
        
        # DBC decoding si nécessaire
        if task.dbc_file and task.dbc_file.exists():
            self.update_task(task.id, progress=10.0, message="Décodage CAN...")
            try:
                print(f"  → Decoding with DBC: {task.dbc_file.name}")
                extracted = mdf.extract_bus_logging(
                    database_files={'CAN': [(str(task.dbc_file), 0)]}
                )
                mdf.close()
                mdf = extracted
            except Exception as e:
                print(f"  → DBC decode failed: {e}")
        
        self.update_task(task.id, progress=15.0, message="Extraction des signaux...")
        
        try:
            # Essaie d'abord l'approche native (plus rapide)
            self._convert_mf4_to_csv_native(mdf, output_path, raster, task)
        except Exception as e:
            print(f"  → Native approach failed: {e}, falling back to manual...")
            # Fallback sur l'approche manuelle
            self._convert_mf4_to_csv_manual(mdf, output_path, raster, task)
        
        mdf.close()
        self._finalize_csv_conversion(task, output_path)
    
    def _convert_mf4_to_csv_native(self, mdf, output_path: Path, raster: float, task: ConversionTask):
        """
        Conversion utilisant les fonctions natives d'asammdf
        mdf.resample() + to_dataframe() - BEAUCOUP plus rapide!
        """
        # Resample si demandé
        if raster:
            self.update_task(task.id, progress=25.0, message=f"Resampling à {raster}s...")
            print(f"  → Resampling to {raster}s raster...")
            start_resample = time.time()
            mdf = mdf.resample(raster=raster)
            print(f"  → Resample done in {time.time() - start_resample:.1f}s")
        
        # Export vers DataFrame
        self.update_task(task.id, progress=50.0, message="Export vers DataFrame...")
        
        # Essaie Polars d'abord (plus rapide), sinon pandas
        try:
            import polars as pl
            print("  → Converting to Polars DataFrame...")
            start_df = time.time()
            df = mdf.to_dataframe(
                reduce_memory_usage=True,
                use_interpolation=False if raster else True,
                use_polars=True
            )
            print(f"  → DataFrame created in {time.time() - start_df:.1f}s ({df.shape})")
            
            self.update_task(task.id, progress=75.0, message="Écriture CSV...")
            
            print(f"  → Writing CSV with Polars...")
            start_csv = time.time()
            df.write_csv(output_path, separator=';', float_precision=4)
            print(f"  → CSV written in {time.time() - start_csv:.1f}s")
            
        except Exception as e:
            print(f"  → Polars failed ({e}), using pandas...")
            
            df = mdf.to_dataframe(
                reduce_memory_usage=True,
                use_interpolation=False if raster else True
            )
            print(f"  → DataFrame shape: {df.shape}")
            
            self.update_task(task.id, progress=75.0, message="Écriture CSV...")
            df.to_csv(output_path, sep=';', index=True, float_format='%.4g')
        
        # Stats finales
        size_mb = output_path.stat().st_size / (1024 * 1024)
        if size_mb >= 1024:
            print(f"  ✓ CSV: {size_mb/1024:.2f} GB")
        else:
            print(f"  ✓ CSV: {size_mb:.1f} MB")
    
    def _convert_mf4_to_csv_manual(self, mdf, output_path: Path, raster: float, task: ConversionTask):
        """
        Conversion manuelle avec interpolation numpy
        Utilisée comme fallback si l'approche native échoue
        """
        # Phase 1: Collecte des noms de canaux valides
        self.update_task(task.id, progress=20.0, message="Analyse des canaux...")
        
        all_channels = []
        
        for grp_idx, group in enumerate(mdf.groups):
            for ch_idx, channel in enumerate(group.channels):
                name = channel.name
                if not name:
                    continue
                name_lower = name.lower()
                if 'time' in name_lower or '$' in name or 'can_dataframe' in name_lower:
                    continue
                if name.endswith('/isx') or name.endswith('/isy'):
                    continue
                all_channels.append((name, grp_idx, ch_idx))
        
        total_channels = len(all_channels)
        print(f"  → {total_channels} channels to process (filtered)")
        
        if total_channels == 0:
            raise ValueError("Aucun canal valide trouvé")
        
        # Phase 2: Extraction par batches
        self.update_task(task.id, progress=25.0, message=f"Lecture de {total_channels} canaux...")
        
        signals_data = []
        t_min, t_max = float('inf'), float('-inf')
        skipped = 0
        
        BATCH_SIZE = 50
        
        for batch_start in range(0, total_channels, BATCH_SIZE):
            batch_end = min(batch_start + BATCH_SIZE, total_channels)
            batch = all_channels[batch_start:batch_end]
            
            channels_spec = [(name, grp_idx, ch_idx) for name, grp_idx, ch_idx in batch]
            
            try:
                sigs = mdf.select(channels_spec, raw=True)
                
                for sig in sigs:
                    if not self._validate_and_add_signal(sig, signals_data):
                        skipped += 1
                        continue
                    
                    ts = signals_data[-1][1]
                    t_min = min(t_min, ts[0])
                    t_max = max(t_max, ts[-1])
                    
            except Exception:
                for name, grp_idx, ch_idx in batch:
                    try:
                        sig = mdf.get(name, group=grp_idx, index=ch_idx, raw=True)
                        if not self._validate_and_add_signal(sig, signals_data):
                            skipped += 1
                            continue
                        ts = signals_data[-1][1]
                        t_min = min(t_min, ts[0])
                        t_max = max(t_max, ts[-1])
                    except Exception:
                        skipped += 1
                        continue
            
            progress = 25.0 + (batch_end / total_channels) * 40.0
            self.update_task(task.id, progress=progress, 
                           message=f"Lecture: {len(signals_data)} signaux ({batch_end}/{total_channels})...")
        
        print(f"  → {len(signals_data)} valid signals, {skipped} skipped")
        
        if not signals_data:
            raise ValueError("Aucun signal valide trouvé")
        
        if t_min >= t_max:
            raise ValueError(f"Plage temporelle invalide: {t_min} - {t_max}")
        
        # Phase 3: Interpolation
        self.update_task(task.id, progress=68.0, message="Interpolation...")
        
        if raster is None:
            raster = 0.01
        
        duration = t_max - t_min
        common_time = np.arange(0, duration + raster, raster, dtype=np.float64)
        n_points = len(common_time)
        n_signals = len(signals_data)
        
        print(f"  → Interpolating {n_signals} signals to {n_points} points...")
        
        data_matrix = np.empty((n_points, n_signals + 1), dtype=np.float64)
        data_matrix[:, 0] = common_time
        
        col_names = ['timestamps']
        
        for i, (name, ts, vals, unit) in enumerate(signals_data):
            ts_shifted = ts - t_min
            data_matrix[:, i + 1] = np.interp(common_time, ts_shifted, vals, left=vals[0], right=vals[-1])
            col_names.append(f"{name} [{unit}]" if unit else name)
            
            if i % 500 == 0:
                progress = 68.0 + (i / n_signals) * 20.0
                self.update_task(task.id, progress=progress, message=f"Interpolation: {i}/{n_signals}...")
        
        del signals_data
        
        self.update_task(task.id, progress=90.0, message="Écriture CSV...")
        self._write_csv(output_path, data_matrix, col_names)
        
        print(f"  ✓ CSV: {n_signals} signals, {n_points} rows, {duration:.1f}s duration")
    
    def _validate_and_add_signal(self, sig, signals_data: list) -> bool:
        """Valide un signal et l'ajoute à la liste si valide."""
        try:
            if sig is None or sig.samples is None or sig.timestamps is None:
                return False
            
            samples = sig.samples
            timestamps = sig.timestamps
            
            if len(samples) == 0 or len(timestamps) == 0:
                return False
            
            if samples.ndim != 1:
                return False
            if hasattr(samples.dtype, 'names') and samples.dtype.names:
                return False
            if not np.issubdtype(samples.dtype, np.number):
                return False
            if len(samples) != len(timestamps):
                return False
            
            ts = np.asarray(timestamps, dtype=np.float64)
            vals = np.asarray(samples, dtype=np.float64)
            
            if not np.isfinite(ts).all() or len(ts) < 2:
                return False
            
            name = sig.name
            unit = str(sig.unit) if sig.unit else ''
            signals_data.append((name, ts, vals, unit))
            return True
            
        except Exception:
            return False
    
    def _write_csv(self, output_path: Path, data: np.ndarray, columns: list):
        """Écrit un CSV avec Polars (fallback pandas)"""
        try:
            import polars as pl
            self._write_csv_polars(output_path, data, columns)
        except ImportError:
            print("  ⚠ Polars not installed, using pandas")
            self._write_csv_pandas(output_path, data, columns)
    
    def _detect_optimal_dtype(self, col_data: np.ndarray) -> tuple:
        """Détecte le type optimal pour une colonne."""
        import polars as pl
        
        if not np.isfinite(col_data).all():
            return ('float32', pl.Float32, col_data.astype(np.float32))
        
        is_integer = np.allclose(col_data, np.round(col_data), rtol=0, atol=1e-9)
        
        if is_integer:
            int_vals = np.round(col_data).astype(np.int64)
            min_val, max_val = int_vals.min(), int_vals.max()
            
            if min_val >= 0 and max_val <= 1:
                unique = np.unique(int_vals)
                if len(unique) <= 2 and all(u in [0, 1] for u in unique):
                    return ('bool', pl.Int8, int_vals.astype(np.int8))
            
            if min_val >= 0:
                if max_val <= 255:
                    return ('uint8', pl.UInt8, int_vals.astype(np.uint8))
                elif max_val <= 65535:
                    return ('uint16', pl.UInt16, int_vals.astype(np.uint16))
                elif max_val <= 4294967295:
                    return ('uint32', pl.UInt32, int_vals.astype(np.uint32))
            
            if -128 <= min_val and max_val <= 127:
                return ('int8', pl.Int8, int_vals.astype(np.int8))
            elif -32768 <= min_val and max_val <= 32767:
                return ('int16', pl.Int16, int_vals.astype(np.int16))
            elif -2147483648 <= min_val and max_val <= 2147483647:
                return ('int32', pl.Int32, int_vals.astype(np.int32))
        
        return ('float32', pl.Float32, col_data.astype(np.float32))
    
    def _write_csv_polars(self, output_path: Path, data: np.ndarray, columns: list):
        """Écrit un CSV avec Polars et détection intelligente des types"""
        import polars as pl
        
        n_rows, n_cols = data.shape
        print(f"  → Analyzing {n_cols} columns for optimal types...")
        
        type_stats = {'float32': 0, 'int8': 0, 'int16': 0, 'int32': 0, 
                      'uint8': 0, 'uint16': 0, 'uint32': 0, 'bool': 0}
        
        CHUNK_SIZE = 100_000
        
        if n_rows <= CHUNK_SIZE:
            col_dict = {}
            
            for i, col_name in enumerate(columns):
                col_data = data[:, i]
                
                if i == 0:
                    col_dict[col_name] = col_data.astype(np.float32)
                    type_stats['float32'] += 1
                else:
                    dtype_name, pl_dtype, converted = self._detect_optimal_dtype(col_data)
                    col_dict[col_name] = converted
                    type_stats[dtype_name] += 1
            
            non_zero = {k: v for k, v in type_stats.items() if v > 0}
            print(f"  → Types detected: {non_zero}")
            
            df = pl.DataFrame(col_dict)
            print(f"  → Writing CSV to {output_path.name}...")
            df.write_csv(output_path, separator=';', float_precision=4)
            
        else:
            print(f"  → Analyzing first chunk for type detection...")
            
            first_chunk = data[:min(10000, n_rows)]
            col_types = []
            
            for i, col_name in enumerate(columns):
                if i == 0:
                    col_types.append(('float32', pl.Float32))
                    type_stats['float32'] += 1
                else:
                    dtype_name, pl_dtype, _ = self._detect_optimal_dtype(first_chunk[:, i])
                    col_types.append((dtype_name, pl_dtype))
                    type_stats[dtype_name] += 1
            
            non_zero = {k: v for k, v in type_stats.items() if v > 0}
            print(f"  → Types detected: {non_zero}")
            print(f"  → Streaming write ({(n_rows + CHUNK_SIZE - 1) // CHUNK_SIZE} chunks)...")
            
            for start in range(0, n_rows, CHUNK_SIZE):
                end = min(start + CHUNK_SIZE, n_rows)
                chunk = data[start:end]
                
                col_dict = {}
                for i, col_name in enumerate(columns):
                    dtype_name, pl_dtype = col_types[i]
                    col_data = chunk[:, i]
                    
                    if dtype_name == 'float32':
                        col_dict[col_name] = col_data.astype(np.float32)
                    elif dtype_name in ('bool', 'int8'):
                        col_dict[col_name] = np.round(col_data).astype(np.int8)
                    elif dtype_name == 'int16':
                        col_dict[col_name] = np.round(col_data).astype(np.int16)
                    elif dtype_name == 'int32':
                        col_dict[col_name] = np.round(col_data).astype(np.int32)
                    elif dtype_name == 'uint8':
                        col_dict[col_name] = np.round(col_data).astype(np.uint8)
                    elif dtype_name == 'uint16':
                        col_dict[col_name] = np.round(col_data).astype(np.uint16)
                    elif dtype_name == 'uint32':
                        col_dict[col_name] = np.round(col_data).astype(np.uint32)
                    else:
                        col_dict[col_name] = col_data.astype(np.float32)
                
                df_chunk = pl.DataFrame(col_dict)
                
                if start == 0:
                    df_chunk.write_csv(output_path, separator=';', float_precision=4)
                else:
                    csv_bytes = df_chunk.write_csv(separator=';', float_precision=4, include_header=False)
                    with open(output_path, 'ab') as f:
                        f.write(csv_bytes.encode('utf-8'))
                
                pct = (end / n_rows) * 100
                print(f"\r  → Writing: {pct:.0f}%", end='', flush=True)
            
            print()
        
        size_mb = output_path.stat().st_size / (1024 * 1024)
        size_gb = size_mb / 1024
        if size_gb >= 1:
            print(f"  → CSV written: {size_gb:.2f} GB")
        else:
            print(f"  → CSV written: {size_mb:.1f} MB")
    
    def _write_csv_pandas(self, output_path: Path, data: np.ndarray, columns: list):
        """Fallback: écrit un CSV avec pandas"""
        import pandas as pd
        
        n_rows, n_cols = data.shape
        print(f"  → Creating pandas DataFrame ({n_rows} rows × {n_cols} cols)...")
        
        data_f32 = data.astype(np.float32)
        df = pd.DataFrame(data_f32, columns=columns)
        del data_f32
        
        mem_mb = df.memory_usage(deep=True).sum() / (1024 * 1024)
        print(f"  → DataFrame memory: {mem_mb:.1f} MB (float32)")
        
        print(f"  → Writing CSV to {output_path.name}...")
        df.to_csv(output_path, sep=';', index=False, float_format='%.4g')
        
        size_mb = output_path.stat().st_size / (1024 * 1024)
        print(f"  → CSV written: {size_mb:.1f} MB")
        
        del df
    
    def _finalize_csv_conversion(self, task: ConversionTask, output_path: Path, n_signals: int = None):
        """Finalise la conversion CSV"""
        self.update_task(task.id, output_file=output_path, progress=100.0, message="Terminé")
        
        try:
            if task.input_file and task.input_file.exists():
                task.input_file.unlink()
            if task.dbc_file and task.dbc_file.exists():
                task.dbc_file.unlink()
        except:
            pass
        
        size_mb = output_path.stat().st_size / (1024 * 1024)
        print(f"  ✓ CSV created: {output_path.name} ({size_mb:.1f} MB)")


# =============================================================================
# Fonctions utilitaires
# =============================================================================

def get_supported_conversions() -> Dict[str, list]:
    """Retourne les conversions supportées par format d'entrée"""
    return {
        'mf4': ['csv'],
    }


def is_conversion_supported(input_format: str, output_format: str) -> bool:
    """Vérifie si une conversion est supportée"""
    supported = get_supported_conversions()
    input_fmt = input_format.lower().lstrip('.')
    output_fmt = output_format.lower().lstrip('.')
    
    return input_fmt in supported and output_fmt in supported.get(input_fmt, [])


# =============================================================================
# MF4 Concatenation
# =============================================================================

@dataclass
class ConcatenationTask:
    """Représente une tâche de concaténation"""
    id: str
    input_files: list
    status: ConversionStatus = ConversionStatus.PENDING
    progress: float = 0.0
    message: str = ""
    output_file: Optional[Path] = None
    error: Optional[str] = None
    stats: Optional[Dict] = None
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None


class ConcatenationManager:
    """Gère les tâches de concaténation MF4"""
    
    def __init__(self, temp_dir: Path):
        self.temp_dir = temp_dir
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.tasks: Dict[str, ConcatenationTask] = {}
        self._lock = threading.Lock()
    
    def create_task(self, input_files: list) -> ConcatenationTask:
        """Crée une nouvelle tâche de concaténation"""
        task_id = str(uuid.uuid4())[:8]
        task = ConcatenationTask(
            id=task_id,
            input_files=input_files
        )
        
        with self._lock:
            self.tasks[task_id] = task
        
        return task
    
    def get_task(self, task_id: str) -> Optional[ConcatenationTask]:
        """Récupère une tâche par son ID"""
        return self.tasks.get(task_id)
    
    def update_task(self, task_id: str, **kwargs):
        """Met à jour une tâche"""
        with self._lock:
            task = self.tasks.get(task_id)
            if task:
                for key, value in kwargs.items():
                    if hasattr(task, key):
                        setattr(task, key, value)
    
    def cleanup_old_tasks(self, max_age_hours: int = 1):
        """Nettoie les anciennes tâches et leurs fichiers"""
        now = time.time()
        max_age_seconds = max_age_hours * 3600
        
        with self._lock:
            to_delete = []
            for task_id, task in self.tasks.items():
                if now - task.created_at > max_age_seconds:
                    for f in task.input_files:
                        if f and f.exists():
                            try:
                                f.unlink()
                            except:
                                pass
                    if task.output_file and task.output_file.exists():
                        try:
                            task.output_file.unlink()
                        except:
                            pass
                    to_delete.append(task_id)
            
            for task_id in to_delete:
                del self.tasks[task_id]
        
        return len(to_delete)
    
    def run_concatenation(self, task_id: str):
        """Lance la concaténation dans un thread séparé"""
        task = self.get_task(task_id)
        if not task:
            return
        
        thread = threading.Thread(target=self._execute_concatenation, args=(task_id,))
        thread.daemon = True
        thread.start()
    
    def _execute_concatenation(self, task_id: str):
        """Exécute la concaténation (appelé dans un thread)"""
        task = self.get_task(task_id)
        if not task:
            return
        
        try:
            self.update_task(task_id, status=ConversionStatus.PROCESSING, progress=0.0, message="Démarrage...")
            self._concatenate_mf4(task)
            self.update_task(
                task_id,
                status=ConversionStatus.COMPLETED,
                progress=100.0,
                message="Concaténation terminée",
                completed_at=time.time()
            )
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.update_task(
                task_id,
                status=ConversionStatus.FAILED,
                error=str(e),
                message=f"Erreur: {str(e)}"
            )
    
    def _concatenate_mf4(self, task: ConcatenationTask):
        """Concatène plusieurs fichiers MF4 en utilisant asammdf.MDF.concatenate"""
        from asammdf import MDF
        
        n_files = len(task.input_files)
        self.update_task(task.id, progress=5.0, message=f"Analyse de {n_files} fichiers...")
        
        # Étape 1: Trouver les signaux communs
        all_signals = []
        
        for i, file_path in enumerate(task.input_files):
            self.update_task(task.id, progress=5 + (i / n_files) * 15, message=f"Analyse fichier {i+1}/{n_files}...")
            with MDF(file_path) as mdf:
                signal_names = set(mdf.channels_db.keys())
                all_signals.append(signal_names)
        
        common_signals = all_signals[0]
        for signals in all_signals[1:]:
            common_signals = common_signals.intersection(signals)
        
        exclude_patterns = ['time', 't_', 'timestamp', 'CAN_DataFrame']
        common_signals = [
            s for s in common_signals 
            if not any(p.lower() in s.lower() for p in exclude_patterns)
        ]
        
        if not common_signals:
            raise ValueError("Aucun signal commun trouvé entre les fichiers")
        
        self.update_task(task.id, progress=25.0, message=f"{len(common_signals)} signaux communs trouvés")
        
        # Étape 2: Filtrer chaque fichier
        filtered_files = []
        
        for i, file_path in enumerate(task.input_files):
            self.update_task(task.id, progress=25 + (i / n_files) * 25, message=f"Filtrage fichier {i+1}/{n_files}...")
            
            with MDF(file_path) as mdf:
                filtered = mdf.filter(common_signals)
                temp_path = self.temp_dir / f"temp_filtered_{task.id}_{i}.mf4"
                filtered.save(temp_path, overwrite=True)
                filtered_files.append(temp_path)
        
        self.update_task(task.id, progress=55.0, message="Concaténation des fichiers...")
        
        # Étape 3: Concaténer
        try:
            merged = MDF.concatenate(
                files=[str(f) for f in filtered_files],
                version='4.10',
                sync=True
            )
        except Exception as e:
            for f in filtered_files:
                try:
                    f.unlink()
                except:
                    pass
            raise e
        
        self.update_task(task.id, progress=80.0, message="Sauvegarde du fichier final...")
        
        output_filename = f"merged_{task.id}.mf4"
        output_path = self.temp_dir / output_filename
        
        merged.save(output_path, overwrite=True)
        
        n_signals = len(common_signals)
        
        try:
            if common_signals:
                sig = merged.get(common_signals[0])
                total_duration = float(sig.timestamps[-1] - sig.timestamps[0]) if len(sig.timestamps) > 0 else 0
            else:
                total_duration = 0
        except:
            total_duration = 0
        
        merged.close()
        
        self.update_task(task.id, progress=90.0, message="Nettoyage...")
        
        for f in filtered_files:
            try:
                f.unlink()
            except:
                pass
        
        for f in task.input_files:
            try:
                if f.exists():
                    f.unlink()
            except:
                pass
        
        stats = {
            'n_files': n_files,
            'n_signals': n_signals,
            'duration': total_duration
        }
        
        self.update_task(task.id, output_file=output_path, stats=stats, progress=100.0)
        
        print(f"  ✓ MF4 concatenated: {output_path} ({n_files} files, {n_signals} signals, {total_duration:.1f}s)")