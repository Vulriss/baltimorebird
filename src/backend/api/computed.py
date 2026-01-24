"""Baltimore Bird - API des variables calculées."""

import re
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from flask import Blueprint, jsonify, request

from data_management import datastore

computed_vars_bp = Blueprint("computed_vars", __name__)

ALLOWED_FUNCTIONS: Dict[str, Any] = {
    "abs": np.abs, "sqrt": np.sqrt, "cbrt": np.cbrt, "square": np.square,
    "exp": np.exp, "log": np.log, "log10": np.log10, "log2": np.log2,
    "sin": np.sin, "cos": np.cos, "tan": np.tan,
    "arcsin": np.arcsin, "arccos": np.arccos, "arctan": np.arctan, "arctan2": np.arctan2,
    "sinh": np.sinh, "cosh": np.cosh, "tanh": np.tanh,
    "deg2rad": np.deg2rad, "rad2deg": np.rad2deg,
    "floor": np.floor, "ceil": np.ceil, "round": np.round, "trunc": np.trunc,
    "clip": np.clip, "sign": np.sign, "minimum": np.minimum, "maximum": np.maximum,
    "pi": np.pi, "e": np.e,
}

FORBIDDEN_PATTERNS: List[str] = [
    r"\bimport\b", r"\bexec\b", r"\beval\b", r"\bcompile\b", r"\bopen\b", r"\bfile\b",
    r"\b__\w+__\b", r"\bgetattr\b", r"\bsetattr\b", r"\bdelattr\b",
    r"\bglobals\b", r"\blocals\b", r"\bvars\b", r"\bdir\b",
    r"\bos\b", r"\bsys\b", r"\bsubprocess\b", r"\blambda\b", r"\bclass\b", r"\bdef\b",
]


def validate_formula(formula: str) -> Tuple[bool, Optional[str]]:
    if not formula or not formula.strip():
        return False, "La formule ne peut pas être vide"
    if len(formula) > 500:
        return False, "La formule est trop longue (max 500 caractères)"
    for pattern in FORBIDDEN_PATTERNS:
        if re.search(pattern, formula, re.IGNORECASE):
            return False, "Expression non autorisée dans la formule"
    if formula.count("(") != formula.count(")"):
        return False, "Parenthèses non équilibrées"
    return True, None


def get_formula_variables(formula: str) -> List[str]:
    variables: set = set()
    for match in re.finditer(r"\b([A-Z])\b", formula):
        variables.add(match.group(1))
    return sorted(variables)


def compute_formula(
    formula: str,
    signal_data: Dict[str, np.ndarray],
    reference_timestamps: np.ndarray
) -> Tuple[np.ndarray, np.ndarray]:
    is_valid, error = validate_formula(formula)
    if not is_valid:
        raise ValueError(error)

    formula_vars = get_formula_variables(formula)
    missing_vars = [v for v in formula_vars if v not in signal_data]
    if missing_vars:
        raise ValueError(f"Variables non définies: {', '.join(missing_vars)}")

    lengths = {k: len(v) for k, v in signal_data.items()}
    unique_lengths = set(lengths.values())

    if len(unique_lengths) > 1:
        raise ValueError("Les signaux ont des longueurs différentes")

    namespace: Dict[str, Any] = {**ALLOWED_FUNCTIONS, **signal_data}

    try:
        result = eval(formula, {"__builtins__": {}}, namespace)

        if isinstance(result, (int, float)):
            result = np.full(len(reference_timestamps), result, dtype=np.float64)
        elif not isinstance(result, np.ndarray):
            result = np.array(result, dtype=np.float64)
        else:
            result = result.astype(np.float64)

        result = np.where(np.isposinf(result), np.finfo(np.float64).max, result)
        result = np.where(np.isneginf(result), np.finfo(np.float64).min, result)

        return reference_timestamps.copy(), result

    except ZeroDivisionError:
        raise ValueError("Division par zéro dans la formule")
    except Exception as e:
        raise ValueError(f"Erreur d'évaluation: {str(e)}")


@computed_vars_bp.route("/api/create-variable", methods=["POST"])
def create_variable():
    if not datastore.loaded:
        return jsonify({"error": "Aucune source de données chargée"}), 400

    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400

        name = data.get("name", "").strip()
        unit = data.get("unit", "").strip()
        description = data.get("description", "").strip()
        formula = data.get("formula", "").strip()
        mapping = data.get("mapping", {})

        if not name:
            return jsonify({"error": "Le nom est requis"}), 400
        if len(name) > 100:
            return jsonify({"error": "Nom trop long (max 100 caractères)"}), 400

        is_valid, error = validate_formula(formula)
        if not is_valid:
            return jsonify({"error": error}), 400

        if not mapping:
            return jsonify({"error": "Au moins une variable doit être mappée"}), 400

        for existing_meta in datastore.metadata:
            if existing_meta["name"] == name:
                return jsonify({"error": f"Un signal nommé '{name}' existe déjà"}), 409

        signal_data: Dict[str, np.ndarray] = {}
        reference_timestamps: Optional[np.ndarray] = None
        reference_length: Optional[int] = None

        for var_letter, signal_name in mapping.items():
            if not re.match(r"^[A-Z]$", var_letter):
                return jsonify({"error": f"'{var_letter}' n'est pas une lettre de variable valide (A-Z)"}), 400

            signal_index: Optional[int] = None
            for i, m in enumerate(datastore.metadata):
                if m["name"] == signal_name:
                    signal_index = i
                    break

            if signal_index is None:
                return jsonify({"error": f"Signal '{signal_name}' non trouvé"}), 404

            sig = datastore.signals[signal_index]
            timestamps = sig["timestamps"]
            values = sig["values"]

            if reference_timestamps is None:
                reference_timestamps = np.asarray(timestamps, dtype=np.float64)
                reference_length = len(timestamps)

            if len(values) != reference_length:
                return jsonify({"error": f"Le signal '{signal_name}' a une longueur différente"}), 400

            signal_data[var_letter] = np.asarray(values, dtype=np.float64)

        if reference_timestamps is None:
            return jsonify({"error": "Aucun signal mappé"}), 400

        try:
            new_timestamps, new_values = compute_formula(formula, signal_data, reference_timestamps)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        hue = (len(datastore.metadata) * 37) % 360
        color = f"hsl({hue}, 70%, 55%)"

        new_index = len(datastore.signals)

        datastore.signals.append({"timestamps": new_timestamps, "values": new_values})

        datastore.metadata.append({
            "name": name,
            "unit": unit,
            "color": color,
            "computed": True,
            "formula": formula,
            "description": description,
            "source_signals": list(mapping.values())
        })

        return jsonify({
            "success": True,
            "signal": {"name": name, "unit": unit, "index": new_index, "color": color}
        })

    except Exception as e:
        return jsonify({"error": f"Erreur interne: {str(e)}"}), 500


@computed_vars_bp.route("/api/computed-variables")
def list_computed_variables():
    if not datastore.loaded:
        return jsonify({"variables": []})

    computed: List[Dict[str, Any]] = []
    for i, meta in enumerate(datastore.metadata):
        if meta.get("computed"):
            computed.append({
                "index": i,
                "name": meta["name"],
                "unit": meta.get("unit", ""),
                "formula": meta.get("formula", ""),
                "description": meta.get("description", ""),
                "source_signals": meta.get("source_signals", [])
            })

    return jsonify({"variables": computed})


@computed_vars_bp.route("/api/computed-variables/<int:index>", methods=["DELETE"])
def delete_computed_variable(index: int):
    if not datastore.loaded:
        return jsonify({"error": "Aucune source de données chargée"}), 400

    if index < 0 or index >= len(datastore.metadata):
        return jsonify({"error": "Index invalide"}), 404

    meta = datastore.metadata[index]
    if not meta.get("computed"):
        return jsonify({"error": "Seules les variables calculées peuvent être supprimées"}), 403

    name = meta["name"]

    del datastore.signals[index]
    del datastore.metadata[index]

    return jsonify({"success": True, "message": f"Variable '{name}' supprimée"})


@computed_vars_bp.route("/api/computed-variables/<int:index>", methods=["PUT"])
def update_computed_variable(index: int):
    if not datastore.loaded:
        return jsonify({"error": "Aucune source de données chargée"}), 400

    if index < 0 or index >= len(datastore.metadata):
        return jsonify({"error": "Index invalide"}), 404

    meta = datastore.metadata[index]
    if not meta.get("computed"):
        return jsonify({"error": "Seules les variables calculées peuvent être modifiées"}), 403

    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400

        unit = data.get("unit", meta.get("unit", "")).strip()
        description = data.get("description", meta.get("description", "")).strip()
        formula = data.get("formula", "").strip()
        mapping = data.get("mapping", {})

        if not formula:
            return jsonify({"error": "La formule est requise"}), 400

        if not mapping:
            return jsonify({"error": "Au moins une variable doit être mappée"}), 400

        signal_data: Dict[str, np.ndarray] = {}
        reference_timestamps: Optional[np.ndarray] = None
        reference_length: Optional[int] = None

        for var_letter, signal_name in mapping.items():
            if not re.match(r"^[A-Z]$", var_letter):
                return jsonify({"error": f"'{var_letter}' n'est pas une lettre de variable valide (A-Z)"}), 400

            signal_index: Optional[int] = None
            for i, m in enumerate(datastore.metadata):
                if m["name"] == signal_name:
                    signal_index = i
                    break

            if signal_index is None:
                return jsonify({"error": f"Signal '{signal_name}' non trouvé"}), 404

            sig = datastore.signals[signal_index]
            timestamps = sig["timestamps"]
            values = sig["values"]

            if reference_timestamps is None:
                reference_timestamps = np.asarray(timestamps, dtype=np.float64)
                reference_length = len(timestamps)

            if len(values) != reference_length:
                return jsonify({"error": f"Le signal '{signal_name}' a une longueur différente"}), 400

            signal_data[var_letter] = np.asarray(values, dtype=np.float64)

        if reference_timestamps is None:
            return jsonify({"error": "Aucun signal mappé"}), 400

        try:
            new_timestamps, new_values = compute_formula(formula, signal_data, reference_timestamps)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        datastore.signals[index] = {"timestamps": new_timestamps, "values": new_values}

        datastore.metadata[index].update({
            "unit": unit,
            "description": description,
            "formula": formula,
            "source_signals": list(mapping.values())
        })

        name = meta["name"]

        return jsonify({
            "success": True,
            "signal": {"name": name, "unit": unit, "index": index, "color": meta["color"]}
        })

    except Exception as e:
        return jsonify({"error": f"Erreur interne: {str(e)}"}), 500
