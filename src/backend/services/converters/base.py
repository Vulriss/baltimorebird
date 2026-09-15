"""Baltimore Bird - Contracts shared by every conversion plugin.

A converter declares the formats it bridges and the options it accepts. The
registry and the task manager depend on this module only, never on a concrete
format, so adding MF4 to Parquet means adding one class and nothing else.

User-facing messages raised from here are in French on purpose: they surface
as-is in the conversion API.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from core.exceptions import ConversionError, ValidationError

ProgressCallback = Callable[[float, str], None]
CancellationCheck = Callable[[], bool]

BOOL_OPTION = "bool"
INT_OPTION = "int"
FLOAT_OPTION = "float"
ENUM_OPTION = "enum"
STR_LIST_OPTION = "str_list"

OPTION_KINDS = frozenset({BOOL_OPTION, INT_OPTION, FLOAT_OPTION, ENUM_OPTION, STR_LIST_OPTION})

MAX_STR_LIST_ITEMS = 5000


class ConversionCancelledError(ConversionError):
    """Raised by a converter when the caller asked for cancellation."""


def normalize_format(fmt: str) -> str:
    """Normalize a format name to its bare lowercase extension.

    Args:
        fmt: Format name, with or without a leading dot.

    Returns:
        The lowercase name without leading dot or surrounding whitespace.
    """
    return fmt.strip().lower().lstrip(".")


def no_progress(percent: float, message: str) -> None:
    """Progress sink used when the caller does not track progress."""


def never_cancelled() -> bool:
    """Cancellation check used when the caller cannot cancel."""
    return False


@dataclass(slots=True, frozen=True)
class OptionSpec:
    """Declarative description of a single converter option.

    The frontend renders a converter form from these specs, so a new option
    becomes visible without touching any view.

    Attributes:
        name: Key used in the options mapping.
        kind: One of `OPTION_KINDS`.
        label: French label shown to the user.
        default: Value applied when the option is absent.
        choices: Allowed values, required for `ENUM_OPTION`.
        minimum: Lower bound, numeric kinds only.
        maximum: Upper bound, numeric kinds only.
    """

    name: str
    kind: str
    label: str
    default: Any = None
    choices: tuple[Any, ...] = ()
    minimum: float | None = None
    maximum: float | None = None

    def __post_init__(self) -> None:
        if self.kind not in OPTION_KINDS:
            raise ValueError(f"Unknown option kind: {self.kind}")
        if self.kind == ENUM_OPTION and not self.choices:
            raise ValueError(f"Enum option {self.name} declares no choices")

    def to_dict(self) -> dict[str, Any]:
        """Serialize the spec for the conversion API."""
        payload: dict[str, Any] = {
            "name": self.name,
            "kind": self.kind,
            "label": self.label,
            "default": self.default,
        }
        if self.choices:
            payload["choices"] = list(self.choices)
        if self.minimum is not None:
            payload["minimum"] = self.minimum
        if self.maximum is not None:
            payload["maximum"] = self.maximum
        return payload


def _coerce_bool(spec: OptionSpec, value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {"true", "false"}:
        return value.lower() == "true"
    raise ValidationError(f"L'option {spec.label} attend un booléen")


def _coerce_number(spec: OptionSpec, value: Any) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"L'option {spec.label} attend un nombre")
    number = int(value) if spec.kind == INT_OPTION else float(value)
    if not math.isfinite(number):
        raise ValidationError(f"L'option {spec.label} attend un nombre fini")
    if spec.minimum is not None and number < spec.minimum:
        raise ValidationError(f"L'option {spec.label} doit valoir au moins {spec.minimum}")
    if spec.maximum is not None and number > spec.maximum:
        raise ValidationError(f"L'option {spec.label} doit valoir au plus {spec.maximum}")
    return number


def _coerce_str_list(spec: OptionSpec, value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        raise ValidationError(f"L'option {spec.label} attend une liste")
    if len(value) > MAX_STR_LIST_ITEMS:
        raise ValidationError(f"L'option {spec.label} est limitée à {MAX_STR_LIST_ITEMS} entrées")
    items: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValidationError(f"L'option {spec.label} n'accepte que des chaînes non vides")
        items.append(item)
    return tuple(items)


def validate_options(specs: Sequence[OptionSpec], raw: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a raw options mapping against a converter's declared specs.

    Unknown keys are rejected rather than ignored, so a typo in a client payload
    fails loudly instead of silently falling back to a default.

    Args:
        specs: Options declared by the converter.
        raw: Options supplied by the caller.

    Returns:
        A mapping holding every declared option, defaults included.

    Raises:
        ValidationError: On an unknown key or an unusable value.
    """
    by_name = {spec.name: spec for spec in specs}
    unknown = sorted(set(raw) - set(by_name))
    if unknown:
        raise ValidationError(f"Options inconnues: {', '.join(unknown)}")

    validated: dict[str, Any] = {}
    for name, spec in by_name.items():
        if name not in raw or raw[name] is None:
            validated[name] = spec.default
            continue
        value = raw[name]
        if spec.kind == BOOL_OPTION:
            validated[name] = _coerce_bool(spec, value)
        elif spec.kind in (INT_OPTION, FLOAT_OPTION):
            validated[name] = _coerce_number(spec, value)
        elif spec.kind == ENUM_OPTION:
            if value not in spec.choices:
                allowed = ", ".join(str(choice) for choice in spec.choices)
                raise ValidationError(f"L'option {spec.label} accepte uniquement: {allowed}")
            validated[name] = value
        else:
            validated[name] = _coerce_str_list(spec, value)
    return validated


@dataclass(slots=True, frozen=True)
class ConversionRequest:
    """Everything a converter needs to produce its artifacts.

    Attributes:
        source: Input file, already validated against directory traversal.
        target_format: Normalized target format.
        work_dir: Directory the converter owns for this conversion. The caller
            guarantees uniqueness; converters never write outside it.
        options: Validated options, as returned by `validate_options`.
        dbc: Optional CAN database used to decode a raw bus log.
        report: Progress sink, called with a percentage and a French message.
        is_cancelled: Polled between units of work.
    """

    source: Path
    target_format: str
    work_dir: Path
    options: Mapping[str, Any] = field(default_factory=dict)
    dbc: Path | None = None
    report: ProgressCallback = no_progress
    is_cancelled: CancellationCheck = never_cancelled

    def raise_if_cancelled(self) -> None:
        """Abort the conversion when the caller asked for it.

        Raises:
            ConversionCancelledError: When `is_cancelled` returns True.
        """
        if self.is_cancelled():
            raise ConversionCancelledError("Conversion annulée")


@dataclass(slots=True)
class ConversionResult:
    """Outcome of a successful conversion.

    Attributes:
        primary: File offered for download.
        artifacts: Every file written, `primary` included, for cleanup.
        details: Converter-specific facts surfaced to the client, such as the
            reading backend actually used or the number of rows written.
    """

    primary: Path
    artifacts: tuple[Path, ...] = ()
    details: dict[str, Any] = field(default_factory=dict)


class Converter(ABC):
    """One format-to-format conversion, registered as a plugin."""

    @property
    @abstractmethod
    def identifier(self) -> str:
        """Stable slug identifying the converter in APIs and logs."""

    @property
    @abstractmethod
    def source_formats(self) -> frozenset[str]:
        """Normalized input formats this converter accepts."""

    @property
    @abstractmethod
    def target_format(self) -> str:
        """Normalized output format this converter produces."""

    @property
    def label(self) -> str:
        """French label shown in the utilities view."""
        return self.identifier

    @property
    def options(self) -> tuple[OptionSpec, ...]:
        """Options the converter accepts. Empty by default."""
        return ()

    @abstractmethod
    def convert(self, request: ConversionRequest) -> ConversionResult:
        """Run the conversion.

        Args:
            request: Validated inputs, options and control hooks.

        Returns:
            The files produced and the facts worth surfacing.

        Raises:
            ConversionError: When the conversion cannot complete.
            ConversionCancelledError: When the caller cancelled it.
        """

    def validate(self, raw_options: Mapping[str, Any]) -> dict[str, Any]:
        """Validate raw options against this converter's specs."""
        return validate_options(self.options, raw_options)

    def describe(self) -> dict[str, Any]:
        """Serialize the converter for the conversion API."""
        return {
            "identifier": self.identifier,
            "label": self.label,
            "source_formats": sorted(self.source_formats),
            "target_format": self.target_format,
            "options": [spec.to_dict() for spec in self.options],
        }
