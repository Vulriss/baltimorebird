"""Baltimore Bird - API des variables calculées."""

import ast
import re
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from flask import Blueprint, g, jsonify, request

from api.auth import optional_auth
from config import ANONYMOUS_USER_ID
from core import sanitize_session_id
from data_management import datastore, lazy_eda

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
    # Logique element-wise (cibles de la reecriture AST, utilisables aussi en direct)
    "logical_and": np.logical_and, "logical_or": np.logical_or,
    "logical_not": np.logical_not, "logical_xor": np.logical_xor,
    "where": np.where,
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


def normalize_formula(formula: str) -> str:
    """Traduit les notations logiques usuelles en Python évaluable (mode eval).

    - ``&&`` / ``||``          -> ``and`` / ``or``
    - ``!`` (hors ``!=``)      -> ``not``
    - ``=`` seul               -> ``==`` (égalité; aucune affectation possible en mode eval)
    - ``AND`` / ``OR`` / ``NOT`` (mots, toute casse) -> mots-clés minuscules

    Les mots AND/OR/NOT ne peuvent pas être confondus avec des variables: celles-ci
    sont des lettres A-Z isolées (``\\b[A-Z]\\b``), jamais des mots de plusieurs lettres.
    """
    f = formula
    f = re.sub(r"&&", " and ", f)
    f = re.sub(r"\|\|", " or ", f)
    f = re.sub(r"!(?!=)", " not ", f)
    f = re.sub(r"(?<![=<>!])=(?!=)", "==", f)
    f = re.sub(r"\b(AND|OR|NOT)\b", lambda m: m.group(1).lower(), f, flags=re.IGNORECASE)
    return f


class _LogicalTransformer(ast.NodeTransformer):
    """Réécrit les opérateurs logiques en appels numpy element-wise.

    Deux pièges de l'eval numpy brut sont neutralisés ici plutôt que documentés:
    - ``A > 3 and B < 5`` lève "truth value is ambiguous" sur des tableaux; ``and``/
      ``or``/``not`` (précédence correcte, plus faible que les comparaisons) deviennent
      logical_and / logical_or / logical_not.
    - ``&``/``|``/``^``/``~`` échouent sur des float64 et, en Python, lient PLUS fort
      que les comparaisons (``A > 3 & B`` parserait ``A > (3 & B)``): on les traite
      comme logique element-wise, en recommandant and/or dans l'UI pour la précédence.
    Les comparaisons chaînées ``0 < A < 5`` (invalides sur tableaux) deviennent
    ``logical_and(0 < A, A < 5)``.
    """

    @staticmethod
    def _call(name: str, args: List[ast.expr]) -> ast.Call:
        return ast.Call(func=ast.Name(id=name, ctx=ast.Load()), args=args, keywords=[])

    def visit_BoolOp(self, node: ast.BoolOp) -> ast.expr:
        self.generic_visit(node)
        name = "logical_and" if isinstance(node.op, ast.And) else "logical_or"
        expr = node.values[0]
        for value in node.values[1:]:
            expr = self._call(name, [expr, value])
        return expr

    def visit_UnaryOp(self, node: ast.UnaryOp) -> ast.expr:
        self.generic_visit(node)
        if isinstance(node.op, (ast.Not, ast.Invert)):
            return self._call("logical_not", [node.operand])
        return node

    def visit_BinOp(self, node: ast.BinOp) -> ast.expr:
        self.generic_visit(node)
        name = {ast.BitAnd: "logical_and", ast.BitOr: "logical_or",
                ast.BitXor: "logical_xor"}.get(type(node.op))
        return self._call(name, [node.left, node.right]) if name else node

    def visit_Compare(self, node: ast.Compare) -> ast.expr:
        self.generic_visit(node)
        if len(node.ops) <= 1:
            return node
        parts: List[ast.expr] = []
        left = node.left
        for op, comparator in zip(node.ops, node.comparators):
            parts.append(ast.Compare(left=left, ops=[op], comparators=[comparator]))
            left = comparator
        expr = parts[0]
        for part in parts[1:]:
            expr = self._call("logical_and", [expr, part])
        return expr


def compile_formula(formula: str):
    """Normalise, parse (mode eval: expressions seules), transforme et compile."""
    normalized = normalize_formula(formula).strip()
    try:
        tree = ast.parse(normalized, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"Formule invalide: {exc.msg}")
    tree = _LogicalTransformer().visit(tree)
    ast.fix_missing_locations(tree)
    return compile(tree, "<formula>", "eval")


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
        code = compile_formula(formula)
        result = eval(code, {"__builtins__": {}}, namespace)

        # bool est un sous-type d'int; np.bool_/np.float64 scalaires passent par np.generic.
        if isinstance(result, (int, float, np.generic)):
            result = np.full(len(reference_timestamps), float(result), dtype=np.float64)
        elif not isinstance(result, np.ndarray):
            result = np.array(result, dtype=np.float64)
        else:
            # Les comparaisons et la logique produisent des tableaux bool -> 0/1.
            result = result.astype(np.float64)

        result = np.where(np.isposinf(result), np.finfo(np.float64).max, result)
        result = np.where(np.isneginf(result), np.finfo(np.float64).min, result)

        return reference_timestamps.copy(), result

    except ValueError:
        raise
    except ZeroDivisionError:
        raise ValueError("Division par zéro dans la formule")
    except Exception as e:
        raise ValueError(f"Erreur d'évaluation: {str(e)}")


def coerce_boolean_result(values: np.ndarray, unit: str) -> np.ndarray:
    """Pour une variable déclarée en unité bool, force un 0/1 propre.

    Convention validée: entre ensembles booléens, ``*`` est un ET (0/1 x 0/1 reste 0/1)
    mais ``+`` (OU) peut produire 2 là où les deux opérandes sont vrais. Le seuillage
    de la visualisation (> 0.5) l'absorberait, mais les mesures de légende afficheraient
    2: on normalise donc en (valeur != 0) dès que l'utilisateur déclare l'unité bool.
    """
    if unit == "bool":
        return (values != 0).astype(np.float64)
    return values


def _resolve_session(session_id: str):
    """Résout une session lazy et vérifie les droits d'accès.
    Retourne (session, None) si autorisé, (None, réponse_erreur) sinon."""
    safe_id = sanitize_session_id(session_id)
    if not safe_id:
        return None, (jsonify({"error": "ID de session invalide"}), 400)

    session = lazy_eda.get_session(safe_id)
    if not session:
        return None, (jsonify({"error": "Session introuvable"}), 404)

    if session.user_id == ANONYMOUS_USER_ID:
        return session, None

    user = getattr(g, "current_user", None)
    if not user:
        return None, (jsonify({"error": "Authentification requise"}), 401)
    if session.user_id != user.id:
        return None, (jsonify({"error": "Accès non autorisé"}), 403)

    return session, None


def _is_step_signal(unit: Optional[str], has_string_map: bool, is_state: bool = False) -> bool:
    """Signaux en escalier (bool / états): interpolation par maintien de valeur.

    Une interpolation linéaire entre deux échantillons d'un booléen ou d'un état
    fabriquerait des valeurs fractionnaires sans sens physique (0.37 entre OFF et
    ON); on maintient la dernière valeur connue, sémantique native de ces voies.
    """
    return bool(has_string_map or is_state or (unit or "").strip().lower() == "bool")


def _align_on_common_raster(entries: List[Dict[str, Any]]):
    """Aligne des signaux de rasters différents sur une base de temps commune.

    entries: [{letter, name, ts, vals, step}]. La référence est le signal le plus
    dense (nombre d'échantillons maximal; à égalité, le premier mappé): aligner sur
    le plus dense préserve tout le détail — l'inverse sous-échantillonnerait la voie
    rapide et pourrait manquer des transitions dans les conditions. Les autres voies
    sont ramenées sur ce raster: interpolation linéaire (analogique) ou maintien de
    la dernière valeur (escalier). La comparaison porte sur les timestamps réels,
    pas seulement les longueurs: deux voies de même taille mais de rasters décalés
    seraient sinon combinées désalignées en silence.

    Retourne (signal_data, reference_timestamps, resample_info|None).
    """
    ref = max(entries, key=lambda e: len(e["ts"]))
    ref_ts = np.asarray(ref["ts"], dtype=np.float64)

    signal_data: Dict[str, np.ndarray] = {}
    resampled: List[str] = []
    for e in entries:
        ts = np.asarray(e["ts"], dtype=np.float64)
        vals = np.asarray(e["vals"], dtype=np.float64)
        if ts.shape == ref_ts.shape and (ts is ref_ts or np.array_equal(ts, ref_ts)):
            signal_data[e["letter"]] = vals
            continue
        if e["step"]:
            # Maintien de valeur: index du dernier échantillon <= t (clippé aux bords).
            idx = np.searchsorted(ts, ref_ts, side="right") - 1
            idx = np.clip(idx, 0, len(vals) - 1)
            signal_data[e["letter"]] = vals[idx]
        else:
            signal_data[e["letter"]] = np.interp(ref_ts, ts, vals)
        resampled.append(e["name"])

    info = None
    if resampled:
        info = {"resampled": resampled, "raster_of": ref["name"], "n_samples": int(len(ref_ts))}
    return signal_data, ref_ts, info


def _resolve_mapped_lazy_signals(session_id: str, mapping: Dict[str, str]):
    """Pour une session lazy, résout chaque signal mappé en données alignées.
    Retourne ((signal_data, reference_timestamps, resample_info), None)
    ou (None, réponse_erreur)."""
    entries: List[Dict[str, Any]] = []

    for var_letter, signal_name in mapping.items():
        if not re.match(r"^[A-Z]$", var_letter):
            return None, (jsonify({"error": f"'{var_letter}' n'est pas une lettre de variable valide (A-Z)"}), 400)

        index = lazy_eda.get_signal_index_by_name(session_id, signal_name)
        if index is None:
            return None, (jsonify({"error": f"Signal '{signal_name}' non trouvé"}), 404)

        lazy_sig = lazy_eda.get_signal_data(session_id, index)
        if not lazy_sig or not lazy_sig.is_loaded:
            return None, (jsonify({"error": f"Signal '{signal_name}' non chargeable"}), 404)

        entries.append({
            "letter": var_letter,
            "name": signal_name,
            "ts": lazy_sig.timestamps,
            "vals": lazy_sig.values,
            "step": _is_step_signal(
                lazy_sig.metadata.unit,
                bool(lazy_sig.string_map),
                bool(getattr(lazy_sig.metadata, "rust_is_state", False)),
            ),
        })

    if not entries:
        return None, (jsonify({"error": "Aucun signal mappé"}), 400)

    signal_data, reference_timestamps, resample_info = _align_on_common_raster(entries)
    return (signal_data, reference_timestamps, resample_info), None


def _resolve_mapped_eager_signals(mapping: Dict[str, str]):
    """Équivalent de _resolve_mapped_lazy_signals pour le datastore eager (sources démo).
    Retourne ((signal_data, reference_timestamps, resample_info), None)
    ou (None, réponse_erreur)."""
    entries: List[Dict[str, Any]] = []

    for var_letter, signal_name in mapping.items():
        if not re.match(r"^[A-Z]$", var_letter):
            return None, (jsonify({"error": f"'{var_letter}' n'est pas une lettre de variable valide (A-Z)"}), 400)

        signal_index: Optional[int] = None
        for i, m in enumerate(datastore.metadata):
            if m["name"] == signal_name:
                signal_index = i
                break

        if signal_index is None:
            return None, (jsonify({"error": f"Signal '{signal_name}' non trouvé"}), 404)

        sig = datastore.signals[signal_index]
        meta = datastore.metadata[signal_index]
        entries.append({
            "letter": var_letter,
            "name": signal_name,
            "ts": sig["timestamps"],
            "vals": sig["values"],
            "step": _is_step_signal(meta.get("unit"), bool(meta.get("string_map") or meta.get("is_categorical"))),
        })

    if not entries:
        return None, (jsonify({"error": "Aucun signal mappé"}), 400)

    signal_data, reference_timestamps, resample_info = _align_on_common_raster(entries)
    return (signal_data, reference_timestamps, resample_info), None


@computed_vars_bp.route("/api/create-variable", methods=["POST"])
@optional_auth
def create_variable():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400

        name = data.get("name", "").strip()
        unit = data.get("unit", "").strip()
        description = data.get("description", "").strip()
        formula = data.get("formula", "").strip()
        mapping = data.get("mapping", {})
        session_id = data.get("session_id")

        if not name:
            return jsonify({"error": "Le nom est requis"}), 400
        if len(name) > 100:
            return jsonify({"error": "Nom trop long (max 100 caractères)"}), 400

        is_valid, error = validate_formula(formula)
        if not is_valid:
            return jsonify({"error": error}), 400

        if not mapping:
            return jsonify({"error": "Au moins une variable doit être mappée"}), 400

        # Branche session lazy (fichier MF4 ouvert par l'utilisateur).
        if session_id:
            session, err = _resolve_session(session_id)
            if err:
                return err
            safe_id = session.session_id
            if lazy_eda.get_signal_index_by_name(safe_id, name) is not None:
                return jsonify({"error": f"Un signal nommé '{name}' existe déjà"}), 409

            resolved, err = _resolve_mapped_lazy_signals(safe_id, mapping)
            if err:
                return err
            signal_data, reference_timestamps, resample_info = resolved
            try:
                new_ts, new_vals = compute_formula(formula, signal_data, reference_timestamps)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            new_vals = coerce_boolean_result(new_vals, unit)

            result = lazy_eda.add_computed_signal(
                safe_id, name, unit, description, formula, list(mapping.values()), new_ts, new_vals
            )
            if result is None:
                return jsonify({"error": "Session introuvable"}), 404
            payload = {"success": True, "signal": result}
            if resample_info:
                payload["resample"] = resample_info
            return jsonify(payload)

        # Branche source classique (datastore eager).
        if not datastore.loaded:
            return jsonify({"error": "Aucune source de données chargée"}), 400

        for existing_meta in datastore.metadata:
            if existing_meta["name"] == name:
                return jsonify({"error": f"Un signal nommé '{name}' existe déjà"}), 409

        resolved, err = _resolve_mapped_eager_signals(mapping)
        if err:
            return err
        signal_data, reference_timestamps, resample_info = resolved

        try:
            new_timestamps, new_values = compute_formula(formula, signal_data, reference_timestamps)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        new_values = coerce_boolean_result(new_values, unit)

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

        payload = {
            "success": True,
            "signal": {"name": name, "unit": unit, "index": new_index, "color": color}
        }
        if resample_info:
            payload["resample"] = resample_info
        return jsonify(payload)

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
@optional_auth
def delete_computed_variable(index: int):
    session_id = request.args.get("session_id")

    # Branche session lazy.
    if session_id:
        session, err = _resolve_session(session_id)
        if err:
            return err
        result = lazy_eda.remove_computed_signal(session.session_id, index)
        if result is None:
            return jsonify({"error": "Index invalide"}), 404
        if result is False:
            return jsonify({"error": "Seules les variables calculées peuvent être supprimées"}), 403
        return jsonify({"success": True})

    # Branche source classique (datastore eager).
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
@optional_auth
def update_computed_variable(index: int):
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400

        formula = data.get("formula", "").strip()
        mapping = data.get("mapping", {})
        session_id = data.get("session_id")

        if not formula:
            return jsonify({"error": "La formule est requise"}), 400
        if not mapping:
            return jsonify({"error": "Au moins une variable doit être mappée"}), 400

        # Branche session lazy (fichier MF4 ouvert par l'utilisateur).
        if session_id:
            session, err = _resolve_session(session_id)
            if err:
                return err
            safe_id = session.session_id
            sig = session.signals.get(index)
            if sig is None:
                return jsonify({"error": "Index invalide"}), 404
            if not sig.metadata.computed:
                return jsonify({"error": "Seules les variables calculées peuvent être modifiées"}), 403

            unit = data.get("unit", sig.metadata.unit).strip()
            description = data.get("description", sig.metadata.description).strip()

            resolved, err = _resolve_mapped_lazy_signals(safe_id, mapping)
            if err:
                return err
            signal_data, reference_timestamps, resample_info = resolved
            try:
                new_ts, new_vals = compute_formula(formula, signal_data, reference_timestamps)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            new_vals = coerce_boolean_result(new_vals, unit)

            result = lazy_eda.update_computed_signal(
                safe_id, index, unit, description, formula, list(mapping.values()), new_ts, new_vals
            )
            if result is None:
                return jsonify({"error": "Index invalide"}), 404
            if result is False:
                return jsonify({"error": "Seules les variables calculées peuvent être modifiées"}), 403
            payload = {"success": True, "signal": result}
            if resample_info:
                payload["resample"] = resample_info
            return jsonify(payload)

        # Branche source classique (datastore eager).
        if not datastore.loaded:
            return jsonify({"error": "Aucune source de données chargée"}), 400

        if index < 0 or index >= len(datastore.metadata):
            return jsonify({"error": "Index invalide"}), 404

        meta = datastore.metadata[index]
        if not meta.get("computed"):
            return jsonify({"error": "Seules les variables calculées peuvent être modifiées"}), 403

        unit = data.get("unit", meta.get("unit", "")).strip()
        description = data.get("description", meta.get("description", "")).strip()

        resolved, err = _resolve_mapped_eager_signals(mapping)
        if err:
            return err
        signal_data, reference_timestamps, resample_info = resolved

        try:
            new_timestamps, new_values = compute_formula(formula, signal_data, reference_timestamps)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        new_values = coerce_boolean_result(new_values, unit)

        datastore.signals[index] = {"timestamps": new_timestamps, "values": new_values}

        datastore.metadata[index].update({
            "unit": unit,
            "description": description,
            "formula": formula,
            "source_signals": list(mapping.values())
        })

        name = meta["name"]

        payload = {
            "success": True,
            "signal": {"name": name, "unit": unit, "index": index, "color": meta["color"]}
        }
        if resample_info:
            payload["resample"] = resample_info
        return jsonify(payload)

    except Exception as e:
        return jsonify({"error": f"Erreur interne: {str(e)}"}), 500
