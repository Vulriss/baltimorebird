"""
Computed Variables API - Création de variables calculées à partir de formules mathématiques.

Usage dans server.py:
    from computed_variables import computed_vars_bp, init_computed_vars
    
    app.register_blueprint(computed_vars_bp)
    init_computed_vars(datastore)  # Après création du datastore
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple

import numpy as np
from flask import Blueprint, jsonify, request
from flask.wrappers import Response

if TYPE_CHECKING:
    from numpy.typing import NDArray


computed_vars_bp = Blueprint("computed_vars", __name__)

# Référence au datastore (initialisée par init_computed_vars)
_datastore: Optional[Any] = None


def init_computed_vars(datastore: Any) -> None:
    """
    Initialise le module avec une référence au datastore.
    
    Args:
        datastore: Instance de MultiSourceDataStore
    """
    global _datastore
    _datastore = datastore
    print("  ✓ Computed variables module initialized")


# Fonctions mathématiques autorisées (sécurisé - pas d'accès au système)
ALLOWED_FUNCTIONS: Dict[str, Any] = {
    # Basic math
    "abs": np.abs,
    "sqrt": np.sqrt,
    "cbrt": np.cbrt,
    "square": np.square,
    "exp": np.exp,
    "log": np.log,
    "log10": np.log10,
    "log2": np.log2,
    
    # Trigonometric
    "sin": np.sin,
    "cos": np.cos,
    "tan": np.tan,
    "arcsin": np.arcsin,
    "arccos": np.arccos,
    "arctan": np.arctan,
    "arctan2": np.arctan2,
    "sinh": np.sinh,
    "cosh": np.cosh,
    "tanh": np.tanh,
    "deg2rad": np.deg2rad,
    "rad2deg": np.rad2deg,
    
    # Rounding
    "floor": np.floor,
    "ceil": np.ceil,
    "round": np.round,
    "trunc": np.trunc,
    
    # Other
    "clip": np.clip,
    "sign": np.sign,
    "minimum": np.minimum,
    "maximum": np.maximum,
    
    # Constants
    "pi": np.pi,
    "e": np.e,
}

# Patterns interdits pour la sécurité
FORBIDDEN_PATTERNS: List[str] = [
    r"\bimport\b",
    r"\bexec\b",
    r"\beval\b",
    r"\bcompile\b",
    r"\bopen\b",
    r"\bfile\b",
    r"\b__\w+__\b",
    r"\bgetattr\b",
    r"\bsetattr\b",
    r"\bdelattr\b",
    r"\bglobals\b",
    r"\blocals\b",
    r"\bvars\b",
    r"\bdir\b",
    r"\bos\b",
    r"\bsys\b",
    r"\bsubprocess\b",
    r"\blambda\b",
    r"\bclass\b",
    r"\bdef\b",
]


def validate_formula(formula: str) -> Tuple[bool, Optional[str]]:
    """
    Valide une formule pour la sécurité.
    
    Args:
        formula: La formule à valider
        
    Returns:
        Tuple (is_valid, error_message)
    """
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
    """
    Extrait les variables (lettres majuscules A-Z) utilisées dans une formule.
    
    Args:
        formula: La formule à analyser
        
    Returns:
        Liste des variables uniques utilisées, triées
    """
    variables: set[str] = set()
    for match in re.finditer(r"\b([A-Z])\b", formula):
        variables.add(match.group(1))
    return sorted(variables)


def compute_formula(
    formula: str,
    signal_data: Dict[str, NDArray[np.float64]],
    reference_timestamps: NDArray[np.float64]
) -> Tuple[NDArray[np.float64], NDArray[np.float64]]:
    """
    Évalue une formule mathématique avec les données des signaux.
    
    Args:
        formula: La formule à évaluer (ex: "A + B * 2.5")
        signal_data: Dict mapping lettres vers arrays numpy de valeurs
        reference_timestamps: Timestamps de référence pour le résultat
        
    Returns:
        Tuple (timestamps, values)
        
    Raises:
        ValueError: Si la formule est invalide ou l'évaluation échoue
    """
    is_valid, error = validate_formula(formula)
    if not is_valid:
        raise ValueError(error)
    
    formula_vars = get_formula_variables(formula)
    missing_vars = [v for v in formula_vars if v not in signal_data]
    if missing_vars:
        raise ValueError(f"Variables non définies: {', '.join(missing_vars)}")
    
    # Vérifier que tous les signaux ont la même longueur
    lengths = {k: len(v) for k, v in signal_data.items()}
    unique_lengths = set(lengths.values())
    
    if len(unique_lengths) > 1:
        raise ValueError(
            f"Les signaux ont des longueurs différentes. "
            f"Interpolation automatique non supportée pour le moment."
        )
    
    # Créer le namespace pour eval (sécurisé)
    namespace: Dict[str, Any] = {**ALLOWED_FUNCTIONS, **signal_data}
    
    try:
        result = eval(formula, {"__builtins__": {}}, namespace)
        
        # Assurer que le résultat est un array numpy
        if isinstance(result, (int, float)):
            result = np.full(len(reference_timestamps), result, dtype=np.float64)
        elif not isinstance(result, np.ndarray):
            result = np.array(result, dtype=np.float64)
        else:
            result = result.astype(np.float64)
        
        # Gérer les valeurs infinies
        result = np.where(np.isposinf(result), np.finfo(np.float64).max, result)
        result = np.where(np.isneginf(result), np.finfo(np.float64).min, result)
        
        return reference_timestamps.copy(), result
        
    except ZeroDivisionError:
        raise ValueError("Division par zéro dans la formule")
    except Exception as e:
        raise ValueError(f"Erreur d'évaluation: {str(e)}")


@computed_vars_bp.route("/api/create-variable", methods=["POST"])
def create_variable() -> Tuple[Response, int] | Response:
    """
    Crée une nouvelle variable calculée à partir d'une formule.
    
    Request body:
        {
            "name": "Puissance_totale",
            "unit": "kW",
            "description": "Somme des puissances",
            "formula": "A + B * 2.5",
            "mapping": {
                "A": "Signal_Name_1",
                "B": "Signal_Name_2"
            }
        }
    
    Response:
        {
            "success": true,
            "signal": {
                "name": "Puissance_totale",
                "unit": "kW",
                "index": 42,
                "color": "hsl(123, 70%, 55%)"
            }
        }
    """
    global _datastore
    
    if _datastore is None:
        return jsonify({"error": "Module non initialisé"}), 500
    
    if not _datastore.loaded:
        return jsonify({"error": "Aucune source de données chargée"}), 400
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400
        
        # Extraire et valider les champs
        name: str = data.get("name", "").strip()
        unit: str = data.get("unit", "").strip()
        description: str = data.get("description", "").strip()
        formula: str = data.get("formula", "").strip()
        mapping: Dict[str, str] = data.get("mapping", {})
        
        # Validation du nom
        if not name:
            return jsonify({"error": "Le nom est requis"}), 400
        
        if not re.match(r"^[a-zA-Z][a-zA-Z0-9_]*$", name):
            return jsonify({
                "error": "Le nom doit commencer par une lettre et ne contenir que des lettres, chiffres et underscores"
            }), 400
        
        if len(name) > 100:
            return jsonify({"error": "Le nom est trop long (max 100 caractères)"}), 400
        
        # Validation de la formule
        if not formula:
            return jsonify({"error": "La formule est requise"}), 400
        
        # Validation du mapping
        if not mapping:
            return jsonify({"error": "Au moins une variable doit être mappée"}), 400
        
        # Vérifier que le nom n'existe pas déjà
        existing_names = [m["name"] for m in _datastore.metadata]
        if name in existing_names:
            return jsonify({"error": f"Une variable '{name}' existe déjà"}), 400
        
        # Résoudre les mappings (nom -> index -> data)
        signal_data: Dict[str, NDArray[np.float64]] = {}
        reference_timestamps: Optional[NDArray[np.float64]] = None
        reference_length: Optional[int] = None
        
        for var_letter, signal_name in mapping.items():
            # Valider la lettre de variable
            if not re.match(r"^[A-Z]$", var_letter):
                return jsonify({"error": f"'{var_letter}' n'est pas une lettre de variable valide (A-Z)"}), 400
            
            # Trouver le signal par son nom
            signal_index: Optional[int] = None
            for i, meta in enumerate(_datastore.metadata):
                if meta["name"] == signal_name:
                    signal_index = i
                    break
            
            if signal_index is None:
                return jsonify({"error": f"Signal '{signal_name}' non trouvé"}), 404
            
            # Récupérer les données du signal
            sig = _datastore.signals[signal_index]
            timestamps = sig["timestamps"]
            values = sig["values"]
            
            # Utiliser les timestamps du premier signal comme référence
            if reference_timestamps is None:
                reference_timestamps = np.asarray(timestamps, dtype=np.float64)
                reference_length = len(timestamps)
            
            # Vérifier la compatibilité des longueurs
            if len(values) != reference_length:
                return jsonify({
                    "error": f"Le signal '{signal_name}' a une longueur différente ({len(values)} vs {reference_length})"
                }), 400
            
            signal_data[var_letter] = np.asarray(values, dtype=np.float64)
        
        # Calculer la nouvelle variable
        if reference_timestamps is None:
            return jsonify({"error": "Aucun signal mappé"}), 400
        
        try:
            new_timestamps, new_values = compute_formula(formula, signal_data, reference_timestamps)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        
        # Générer une couleur pour le nouveau signal
        hue = (len(_datastore.metadata) * 37) % 360
        color = f"hsl({hue}, 70%, 55%)"
        
        # Ajouter au datastore
        new_index = len(_datastore.signals)
        
        _datastore.signals.append({
            "timestamps": new_timestamps,
            "values": new_values
        })
        
        _datastore.metadata.append({
            "name": name,
            "unit": unit,
            "color": color,
            "computed": True,
            "formula": formula,
            "description": description,
            "source_signals": list(mapping.values())
        })
        
        print(f"  ✓ Created computed variable: {name} = {formula}")
        
        return jsonify({
            "success": True,
            "signal": {
                "name": name,
                "unit": unit,
                "index": new_index,
                "color": color
            }
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Erreur interne: {str(e)}"}), 500


@computed_vars_bp.route("/api/computed-variables", methods=["GET"])
def list_computed_variables() -> Response:
    """
    Liste toutes les variables calculées dans la source actuelle.
    
    Response:
        {
            "variables": [
                {
                    "index": 42,
                    "name": "Puissance_totale",
                    "unit": "kW",
                    "formula": "A + B * 2.5",
                    "source_signals": ["Signal_1", "Signal_2"]
                }
            ]
        }
    """
    global _datastore
    
    if _datastore is None or not _datastore.loaded:
        return jsonify({"variables": []})
    
    computed: List[Dict[str, Any]] = []
    for i, meta in enumerate(_datastore.metadata):
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
def delete_computed_variable(index: int) -> Tuple[Response, int] | Response:
    """
    Supprime une variable calculée.
    
    Note: Seules les variables marquées comme 'computed' peuvent être supprimées.
    """
    global _datastore
    
    if _datastore is None or not _datastore.loaded:
        return jsonify({"error": "Aucune source de données chargée"}), 400
    
    if index < 0 or index >= len(_datastore.metadata):
        return jsonify({"error": "Index invalide"}), 404
    
    meta = _datastore.metadata[index]
    if not meta.get("computed"):
        return jsonify({"error": "Seules les variables calculées peuvent être supprimées"}), 403
    
    name = meta["name"]
    
    # Supprimer du datastore
    del _datastore.signals[index]
    del _datastore.metadata[index]
    
    print(f"  ✗ Deleted computed variable: {name}")
    
    return jsonify({"success": True, "message": f"Variable '{name}' supprimée"})


@computed_vars_bp.route("/api/computed-variables/<int:index>", methods=["PUT"])
def update_computed_variable(index: int) -> Tuple[Response, int] | Response:
    """
    Met à jour une variable calculée existante.
    
    Request body:
        {
            "unit": "kW",
            "description": "Description mise à jour",
            "formula": "A + B * 3",
            "mapping": {
                "A": "Signal_Name_1",
                "B": "Signal_Name_2"
            }
        }
    
    Note: Le nom ne peut pas être modifié.
    """
    global _datastore
    
    if _datastore is None:
        return jsonify({"error": "Module non initialisé"}), 500
    
    if not _datastore.loaded:
        return jsonify({"error": "Aucune source de données chargée"}), 400
    
    if index < 0 or index >= len(_datastore.metadata):
        return jsonify({"error": "Index invalide"}), 404
    
    meta = _datastore.metadata[index]
    if not meta.get("computed"):
        return jsonify({"error": "Seules les variables calculées peuvent être modifiées"}), 403
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400
        
        # Extraire les champs (le nom reste inchangé)
        unit: str = data.get("unit", meta.get("unit", "")).strip()
        description: str = data.get("description", meta.get("description", "")).strip()
        formula: str = data.get("formula", "").strip()
        mapping: Dict[str, str] = data.get("mapping", {})
        
        # Validation de la formule
        if not formula:
            return jsonify({"error": "La formule est requise"}), 400
        
        # Validation du mapping
        if not mapping:
            return jsonify({"error": "Au moins une variable doit être mappée"}), 400
        
        # Résoudre les mappings
        signal_data: Dict[str, NDArray[np.float64]] = {}
        reference_timestamps: Optional[NDArray[np.float64]] = None
        reference_length: Optional[int] = None
        
        for var_letter, signal_name in mapping.items():
            if not re.match(r"^[A-Z]$", var_letter):
                return jsonify({"error": f"'{var_letter}' n'est pas une lettre de variable valide (A-Z)"}), 400
            
            signal_index: Optional[int] = None
            for i, m in enumerate(_datastore.metadata):
                if m["name"] == signal_name:
                    signal_index = i
                    break
            
            if signal_index is None:
                return jsonify({"error": f"Signal '{signal_name}' non trouvé"}), 404
            
            sig = _datastore.signals[signal_index]
            timestamps = sig["timestamps"]
            values = sig["values"]
            
            if reference_timestamps is None:
                reference_timestamps = np.asarray(timestamps, dtype=np.float64)
                reference_length = len(timestamps)
            
            if len(values) != reference_length:
                return jsonify({
                    "error": f"Le signal '{signal_name}' a une longueur différente ({len(values)} vs {reference_length})"
                }), 400
            
            signal_data[var_letter] = np.asarray(values, dtype=np.float64)
        
        if reference_timestamps is None:
            return jsonify({"error": "Aucun signal mappé"}), 400
        
        # Calculer la nouvelle variable
        try:
            new_timestamps, new_values = compute_formula(formula, signal_data, reference_timestamps)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        
        # Mettre à jour le datastore
        _datastore.signals[index] = {
            "timestamps": new_timestamps,
            "values": new_values
        }
        
        _datastore.metadata[index].update({
            "unit": unit,
            "description": description,
            "formula": formula,
            "source_signals": list(mapping.values())
        })
        
        name = meta["name"]
        print(f"Updated computed variable: {name} = {formula}")
        
        return jsonify({
            "success": True,
            "signal": {
                "name": name,
                "unit": unit,
                "index": index,
                "color": meta["color"]
            }
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Erreur interne: {str(e)}"}), 500