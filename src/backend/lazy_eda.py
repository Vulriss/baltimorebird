import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Any
import numpy as np


@dataclass
class SignalMetadata:
    """Metadata for a signal (without data)."""
    index: int
    name: str
    unit: str
    color: str
    group_index: int = 0
    channel_index: int = 0
    loaded: bool = False


@dataclass 
class LazySignal:
    """Signal with lazy-loaded data."""
    metadata: SignalMetadata
    timestamps: Optional[np.ndarray] = None
    values: Optional[np.ndarray] = None
    
    @property
    def is_loaded(self) -> bool:
        return self.timestamps is not None and self.values is not None


@dataclass
class LazySession:
    """A lazy-loading EDA session."""
    session_id: str
    user_id: str
    mf4_path: Path
    dbc_path: Optional[Path] = None
    filename: str = ""
    
    # Signal metadata (always available after list_signals)
    signals: Dict[int, LazySignal] = field(default_factory=dict)
    signal_names: List[str] = field(default_factory=list)
    
    # File-level metadata
    t_min: float = 0.0
    t_max: float = 0.0
    n_signals: int = 0
    
    # State
    mdf_handle: Any = None  # Keep MDF open for faster access
    listed: bool = False
    created_at: float = field(default_factory=time.time)
    last_access: float = field(default_factory=time.time)
    
    def touch(self):
        """Update last access time."""
        self.last_access = time.time()


class LazyEDAManager:
    """Manages lazy-loading EDA sessions."""
    
    def __init__(self, max_sessions: int = 50, session_timeout: int = 3600):
        self.sessions: Dict[str, LazySession] = {}
        self.max_sessions = max_sessions
        self.session_timeout = session_timeout  # 1 hour default
    
    def create_session(self, session_id: str, user_id: str, mf4_path: Path, 
                       dbc_path: Optional[Path] = None) -> LazySession:
        """Create a new lazy session."""
        self._cleanup_old_sessions()
        
        session = LazySession(
            session_id=session_id,
            user_id=user_id,
            mf4_path=mf4_path,
            dbc_path=dbc_path,
            filename=mf4_path.name
        )
        self.sessions[session_id] = session
        return session
    
    def get_session(self, session_id: str) -> Optional[LazySession]:
        """Get a session by ID."""
        session = self.sessions.get(session_id)
        if session:
            session.touch()
        return session
    
    def list_signals(self, session_id: str) -> Optional[Dict]:
        """
        List all signals in the MF4 file WITHOUT loading sample data.
        This is FAST because we only read channel metadata from the file header.
        """
        session = self.get_session(session_id)
        if not session:
            return None
        
        if session.listed:
            # Already listed, return cached metadata
            return self._format_signal_list(session)
        
        from asammdf import MDF
        
        start_time = time.time()
        print(f"[LazyEDA] Listing signals for session {session_id[:8]}...")
        
        try:
            mdf = MDF(session.mf4_path)
            
            # Apply DBC decoding if available
            if session.dbc_path and session.dbc_path.exists():
                print(f"[LazyEDA] Applying DBC decoding...")
                decode_start = time.time()
                extracted = mdf.extract_bus_logging(
                    database_files={"CAN": [(str(session.dbc_path), 0)]}
                )
                mdf.close()
                mdf = extracted
                print(f"[LazyEDA] DBC decoding done in {time.time() - decode_start:.2f}s")
            
            # Keep MDF handle open for faster subsequent loads
            session.mdf_handle = mdf
            
            # Get all channel names - this is fast, just reads metadata
            signal_names = list(mdf.channels_db.keys())
            exclude_patterns = ["time", "t_", "timestamp", "CAN_DataFrame"]
            filtered_names = [
                n for n in signal_names 
                if not any(p.lower() in n.lower() for p in exclude_patterns)
            ]
            
            print(f"[LazyEDA] Found {len(filtered_names)} channels, collecting metadata...")
            
            # Collect metadata WITHOUT loading sample data
            # We use iter_channels which is much faster than get()
            valid_signals = []
            channel_info = {}  # name -> (group_idx, channel_idx, unit)
            
            # Build channel info map from channels_db
            for name in filtered_names:
                groups = mdf.channels_db.get(name, [])
                if groups:
                    group_idx, channel_idx = groups[0]
                    channel_info[name] = (group_idx, channel_idx)
            
            # Get time range by sampling just the first valid channel
            t_min_global = float('inf')
            t_max_global = float('-inf')
            sampled_one = False
            
            for name, (group_idx, channel_idx) in channel_info.items():
                try:
                    # Get channel object (metadata only, not samples)
                    group = mdf.groups[group_idx]
                    channel = group.channels[channel_idx]
                    
                    # Get unit from channel metadata
                    unit = ""
                    if hasattr(channel, 'unit'):
                        unit = str(channel.unit) if channel.unit else ""
                    
                    # Check if numeric type (skip string channels)
                    # We check the data type without loading all samples
                    dtype = None
                    if hasattr(channel, 'dtype'):
                        dtype = channel.dtype
                    
                    # For time range, we need to sample at least one channel
                    # But we only do this once, not for every channel
                    if not sampled_one:
                        try:
                            sig = mdf.get(name, group=group_idx, index=channel_idx, raw=True)
                            if sig is not None and sig.timestamps is not None and len(sig.timestamps) > 0:
                                t_min_global = float(sig.timestamps[0])
                                t_max_global = float(sig.timestamps[-1])
                                sampled_one = True
                                
                                # While we have this signal, check if it's numeric
                                if not np.issubdtype(sig.samples.dtype, np.number):
                                    continue
                        except:
                            pass
                    
                    # Create signal metadata
                    hue = (len(valid_signals) * 37) % 360
                    metadata = SignalMetadata(
                        index=len(valid_signals),
                        name=name,
                        unit=unit,
                        color=f"hsl({hue}, 70%, 55%)",
                        group_index=group_idx,
                        channel_index=channel_idx,
                        loaded=False
                    )
                    
                    lazy_signal = LazySignal(metadata=metadata)
                    session.signals[len(valid_signals)] = lazy_signal
                    session.signal_names.append(name)
                    valid_signals.append(metadata)
                    
                except Exception as e:
                    continue
            
            session.n_signals = len(valid_signals)
            session.t_min = t_min_global if t_min_global != float('inf') else 0
            session.t_max = t_max_global if t_max_global != float('-inf') else 0
            session.listed = True
            
            elapsed = time.time() - start_time
            print(f"[LazyEDA] Listed {session.n_signals} signals in {elapsed:.2f}s")
            
            return self._format_signal_list(session)
            
        except Exception as e:
            print(f"[LazyEDA] Error listing signals: {e}")
            import traceback
            traceback.print_exc()
            if session.mdf_handle:
                try:
                    session.mdf_handle.close()
                except:
                    pass
                session.mdf_handle = None
            raise
    
    def preload_signal(self, session_id: str, signal_index: int) -> Optional[Dict]:
        """
        Preload a specific signal's data.
        Called on hover to prepare data before drag-and-drop.
        """
        session = self.get_session(session_id)
        if not session or not session.listed:
            return None
        
        if signal_index not in session.signals:
            return None
        
        lazy_signal = session.signals[signal_index]
        
        # Already loaded
        if lazy_signal.is_loaded:
            return {
                "index": signal_index,
                "name": lazy_signal.metadata.name,
                "status": "ready",
                "n_samples": len(lazy_signal.timestamps) if lazy_signal.timestamps is not None else 0
            }
        
        start_time = time.time()
        meta = lazy_signal.metadata
        signal_name = meta.name
        
        try:
            mdf = session.mdf_handle
            if mdf is None:
                # Re-open if closed
                from asammdf import MDF
                mdf = MDF(session.mf4_path)
                if session.dbc_path and session.dbc_path.exists():
                    extracted = mdf.extract_bus_logging(
                        database_files={"CAN": [(str(session.dbc_path), 0)]}
                    )
                    mdf.close()
                    mdf = extracted
                session.mdf_handle = mdf
            
            # Load full signal data using stored group/channel indices
            sig = mdf.get(
                signal_name, 
                group=meta.group_index, 
                index=meta.channel_index
            )
            
            if sig is None or sig.samples is None or len(sig.samples) == 0:
                return {"index": signal_index, "status": "error", "error": "Signal empty"}
            
            if not np.issubdtype(sig.samples.dtype, np.number):
                return {"index": signal_index, "status": "error", "error": "Non-numeric signal"}
            
            timestamps = np.asarray(sig.timestamps, dtype=np.float64)
            values = np.asarray(sig.samples, dtype=np.float64)
            
            # Handle NaN values
            mask = ~np.isfinite(values)
            if mask.all():
                return {"index": signal_index, "status": "error", "error": "All NaN values"}
            
            if mask.any():
                valid_mask = ~mask
                values[mask] = np.interp(
                    timestamps[mask], 
                    timestamps[valid_mask], 
                    values[valid_mask],
                    left=values[valid_mask][0], 
                    right=values[valid_mask][-1]
                )
            
            # Store loaded data
            lazy_signal.timestamps = timestamps
            lazy_signal.values = values
            lazy_signal.metadata.loaded = True
            
            elapsed = (time.time() - start_time) * 1000
            print(f"[LazyEDA] Preloaded '{signal_name}' ({len(timestamps):,} pts) in {elapsed:.1f}ms")
            
            return {
                "index": signal_index,
                "name": signal_name,
                "status": "ready",
                "n_samples": len(timestamps),
                "load_time_ms": round(elapsed, 1)
            }
            
        except Exception as e:
            print(f"[LazyEDA] Error preloading signal {signal_index}: {e}")
            return {"index": signal_index, "status": "error", "error": str(e)}
    
    def get_signal_data(self, session_id: str, signal_index: int) -> Optional[LazySignal]:
        """Get loaded signal data for visualization."""
        session = self.get_session(session_id)
        if not session:
            return None
        
        lazy_signal = session.signals.get(signal_index)
        if not lazy_signal:
            return None
        
        # Auto-load if not loaded yet
        if not lazy_signal.is_loaded:
            self.preload_signal(session_id, signal_index)
        
        return lazy_signal
    
    def close_session(self, session_id: str):
        """Close a session and free resources."""
        session = self.sessions.pop(session_id, None)
        if session and session.mdf_handle:
            try:
                session.mdf_handle.close()
                print(f"[LazyEDA] Closed MDF handle for session {session_id[:8]}")
            except:
                pass
    
    def _cleanup_old_sessions(self):
        """Remove old sessions to free memory."""
        now = time.time()
        to_remove = []
        
        for sid, session in self.sessions.items():
            if now - session.last_access > self.session_timeout:
                to_remove.append(sid)
        
        for sid in to_remove:
            self.close_session(sid)
            print(f"[LazyEDA] Cleaned up expired session {sid[:8]}")
        
        # Also remove if too many sessions
        if len(self.sessions) > self.max_sessions:
            # Remove oldest sessions
            sorted_sessions = sorted(
                self.sessions.items(), 
                key=lambda x: x[1].last_access
            )
            for sid, _ in sorted_sessions[:len(self.sessions) - self.max_sessions]:
                self.close_session(sid)
    
    def _format_signal_list(self, session: LazySession) -> Dict:
        """Format signal list for API response."""
        signals = []
        for idx, lazy_sig in sorted(session.signals.items()):
            meta = lazy_sig.metadata
            signals.append({
                "index": meta.index,
                "name": meta.name,
                "unit": meta.unit,
                "color": meta.color,
                "loaded": lazy_sig.is_loaded
            })
        
        return {
            "session_id": session.session_id,
            "filename": session.filename,
            "n_signals": session.n_signals,
            "time_range": {
                "min": session.t_min,
                "max": session.t_max
            },
            "duration": session.t_max - session.t_min,
            "signals": signals
        }


# Global instance
lazy_eda = LazyEDAManager()