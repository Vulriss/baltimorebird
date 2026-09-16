"""Baltimore Bird - Conversion plugins.

The process-wide `registry` is the only entry point the conversion service
depends on. Adding a format means writing a `Converter` and registering it here.
"""

from __future__ import annotations

from .base import (
    ConversionCancelledError,
    ConversionRequest,
    ConversionResult,
    Converter,
    OptionSpec,
    normalize_format,
    validate_options,
)
from .mf4_csv import Mf4ToCsvConverter
from .registry import ConverterRegistry

registry = ConverterRegistry()
registry.register(Mf4ToCsvConverter())

__all__ = [
    "ConversionCancelledError",
    "ConversionRequest",
    "ConversionResult",
    "Converter",
    "ConverterRegistry",
    "Mf4ToCsvConverter",
    "OptionSpec",
    "normalize_format",
    "registry",
    "validate_options",
]
