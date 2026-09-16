"""Baltimore Bird - Converter registry.

Holds the `(source format, target format)` routing table. Nothing here knows
what MF4 or CSV are, which is what keeps the conversion service closed to
modification while the catalogue stays open to extension.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from core.exceptions import ValidationError

from .base import Converter, normalize_format

logger = logging.getLogger(__name__)


class ConverterRegistry:
    """Thread-safe catalogue of the available converters."""

    def __init__(self) -> None:
        self._routes: dict[tuple[str, str], Converter] = {}
        self._lock = threading.RLock()

    def register(self, converter: Converter) -> None:
        """Add a converter to the catalogue.

        Args:
            converter: Converter to register.

        Raises:
            ValidationError: When the converter declares no source format, or
                when one of its routes is already served.
        """
        target = normalize_format(converter.target_format)
        sources = {normalize_format(fmt) for fmt in converter.source_formats}
        if not target or not sources:
            raise ValidationError(f"Le convertisseur {converter.identifier} déclare une route incomplète")

        with self._lock:
            conflicts = [source for source in sources if (source, target) in self._routes]
            if conflicts:
                raise ValidationError(
                    f"Route déjà enregistrée pour {converter.identifier}: "
                    f"{', '.join(f'{source} -> {target}' for source in sorted(conflicts))}"
                )
            for source in sources:
                self._routes[(source, target)] = converter
        logger.info("Registered converter %s for %s -> %s", converter.identifier, sorted(sources), target)

    def resolve(self, source_format: str, target_format: str) -> Converter | None:
        """Return the converter serving a route, or None when unsupported."""
        key = (normalize_format(source_format), normalize_format(target_format))
        with self._lock:
            return self._routes.get(key)

    def supports(self, source_format: str, target_format: str) -> bool:
        """Report whether a route is served."""
        return self.resolve(source_format, target_format) is not None

    def matrix(self) -> dict[str, list[str]]:
        """Return the supported target formats indexed by source format."""
        with self._lock:
            routes = list(self._routes)
        matrix: dict[str, list[str]] = {}
        for source, target in routes:
            matrix.setdefault(source, []).append(target)
        return {source: sorted(targets) for source, targets in sorted(matrix.items())}

    def describe(self) -> list[dict[str, Any]]:
        """Serialize every registered converter, deduplicated and sorted."""
        with self._lock:
            converters = list(self._routes.values())
        unique = {converter.identifier: converter for converter in converters}
        return [unique[identifier].describe() for identifier in sorted(unique)]

    def clear(self) -> None:
        """Drop every route. Intended for tests."""
        with self._lock:
            self._routes.clear()
