"""Baltimore Bird - Customs exceptions."""


class BaltimoreBirdError(Exception):
    """Classe de base pour les exceptions de l'application."""
    pass


class DataLoadError(BaltimoreBirdError):
    """Erreur lors du chargement de données."""
    pass


class ValidationError(BaltimoreBirdError):
    """Erreur de validation des données d'entrée."""
    pass


class AuthenticationError(BaltimoreBirdError):
    """Erreur d'authentification."""
    pass


class AuthorizationError(BaltimoreBirdError):
    """Erreur d'autorisation (accès refusé)."""
    pass


class StorageQuotaExceededError(BaltimoreBirdError):
    """Quota de stockage dépassé."""
    pass


class UnsafeCodeError(BaltimoreBirdError):
    """Code dangereux détecté dans le sandbox."""
    pass


class ExecutionTimeoutError(BaltimoreBirdError):
    """Timeout d'exécution dans le sandbox."""
    pass


class ConversionError(BaltimoreBirdError):
    """Erreur lors de la conversion de fichiers."""
    pass