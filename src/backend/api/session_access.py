"""Baltimore Bird - Résolution et contrôle d'accès des sessions EDA.

Point d'entrée unique de toutes les routes manipulant une session (EDA, vues, variables
calculées): validation de l'identifiant, contrôle d'accès et reconstruction d'une session
évincée y sont décidés une seule fois, pour un comportement identique partout.

L'ordre des opérations est une propriété de sécurité: le contrôle d'accès s'applique au
propriétaire déclaré par le descripteur AVANT toute reconstruction. Un identifiant de session
qui aurait fuité ne déclenche donc aucune ouverture de fichier ni aucun parsing au profit d'un
tiers, et les codes de réponse sont les mêmes qu'une session soit en mémoire ou évincée: rien
ne permet de deviner l'état interne du serveur.
"""

from typing import Optional, Tuple

from flask import Response, g, jsonify

from config import ANONYMOUS_USER_ID
from core import sanitize_session_id
from data_management import lazy_eda
from data_management.sessions import LazySession

ErrorResponse = Tuple[Response, int]

SESSION_EXPIRED_MESSAGE = (
    "Session d'analyse expirée: le fichier n'est plus chargé côté serveur. Rechargez-le pour continuer."
)


def _authorize(owner_id: str) -> Optional[ErrorResponse]:
    """Vérifie que l'appelant a le droit d'accéder à une session appartenant à ``owner_id``.

    Les sessions anonymes sont éphémères et identifiées par un UUID non devinable: la
    connaissance de cet UUID vaut autorisation (modèle capability). Les sessions d'utilisateurs
    authentifiés exigent le token du propriétaire. Retourne None quand l'accès est autorisé.
    """
    if owner_id == ANONYMOUS_USER_ID:
        return None

    user = getattr(g, "current_user", None)
    if not user:
        return jsonify({"error": "Authentification requise", "code": "auth_required"}), 401
    if owner_id != user.id:
        return jsonify({"error": "Accès non autorisé", "code": "forbidden"}), 403
    return None


def _session_expired() -> ErrorResponse:
    """Réponse d'une session introuvable, avec un code distinct de ceux de l'authentification.

    Le client peut ainsi proposer un rechargement du fichier au lieu de laisser croire à un
    problème de connexion, confusion entretenue par le mot "session".
    """
    return jsonify({"error": SESSION_EXPIRED_MESSAGE, "code": "session_expired"}), 404


def resolve_session(session_id: str) -> Tuple[Optional[LazySession], Optional[ErrorResponse]]:
    """Résout une session EDA et vérifie les droits d'accès.

    Retourne (session, None) si l'accès est autorisé, (None, réponse_erreur) sinon. Une session
    absente de la mémoire est reconstruite depuis son descripteur disque au profit de son seul
    propriétaire: l'expiration, la pression mémoire et le redémarrage du service cessent d'être
    visibles de l'utilisateur.
    """
    safe_id = sanitize_session_id(session_id)
    if not safe_id:
        return None, (jsonify({"error": "ID de session invalide", "code": "invalid_session_id"}), 400)

    session = lazy_eda.get_session(safe_id)
    if session is not None:
        error = _authorize(session.user_id)
        return (None, error) if error else (session, None)

    owner_id = lazy_eda.persisted_owner(safe_id)
    if owner_id is None:
        return None, _session_expired()

    error = _authorize(owner_id)
    if error:
        return None, error

    session = lazy_eda.restore_session(safe_id, owner_id=owner_id)
    if session is None:
        return None, _session_expired()

    return session, None
