"""
Secure Script Executor - Sandbox pour exécuter les scripts d'analyse
Protège contre l'exécution de code malveillant
"""

import ast
import sys
import time
import threading
from typing import Dict, Any, Optional, List, Set
from dataclasses import dataclass
from io import StringIO
import traceback


# =============================================================================
# Configuration de sécurité
# =============================================================================

# Modules autorisés pour l'import
ALLOWED_MODULES = {
    # Data manipulation
    'numpy', 'np',
    'pandas', 'pd',
    'statistics',
    'math',
    'decimal',
    'fractions',
    'random',
    'collections',
    'itertools',
    'functools',
    
    # Date/time
    'datetime',
    'time',  # Seulement pour time.sleep limité
    
    # String/text
    're',
    'string',
    'json',
    
    # Typing
    'typing',
}

# Fonctions built-in autorisées
ALLOWED_BUILTINS = {
    # Types de base
    'int', 'float', 'str', 'bool', 'bytes',
    'list', 'dict', 'set', 'tuple', 'frozenset',
    'type', 'object',
    
    # Fonctions utilitaires
    'len', 'range', 'enumerate', 'zip', 'map', 'filter',
    'sorted', 'reversed', 'min', 'max', 'sum', 'abs',
    'round', 'pow', 'divmod',
    'all', 'any',
    'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
    'callable', 'iter', 'next',
    
    # Conversion
    'bin', 'hex', 'oct', 'ord', 'chr',
    'format', 'repr', 'ascii',
    
    # Autres
    'print', 'id', 'hash',
    'slice', 'property', 'staticmethod', 'classmethod',
    'super',
    
    # Exceptions (pour try/except)
    'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
    'AttributeError', 'RuntimeError', 'StopIteration', 'ZeroDivisionError',
}

# Attributs interdits (dangereux)
FORBIDDEN_ATTRS = {
    '__import__', '__loader__', '__spec__',
    '__builtins__', '__globals__', '__locals__',
    '__code__', '__closure__', '__func__',
    '__self__', '__dict__', '__class__', '__bases__', '__mro__',
    '__subclasses__', '__init_subclass__',
    '_getframe', '_current_frames',
    'gi_frame', 'gi_code', 'f_globals', 'f_locals', 'f_code',
    'co_code', 'func_globals', 'func_code',
}

# Noms interdits
FORBIDDEN_NAMES = {
    'eval', 'exec', 'compile', 'execfile',
    'open', 'file', 'input', 'raw_input',
    'reload', '__import__',
    'globals', 'locals', 'vars', 'dir',
    'getattr', 'setattr', 'delattr',  # On peut les autoriser avec précaution
    'memoryview', 'bytearray',
    'breakpoint', 'credits', 'license', 'copyright',
    'exit', 'quit',
}


# =============================================================================
# AST Validator - Analyse statique du code
# =============================================================================

class UnsafeCodeError(Exception):
    """Raised when unsafe code is detected"""
    pass


class CodeValidator(ast.NodeVisitor):
    """Validateur AST pour détecter le code dangereux"""
    
    def __init__(self):
        self.errors: List[str] = []
        self.imports: Set[str] = set()
    
    def visit_Import(self, node: ast.Import):
        """Vérifie les imports"""
        for alias in node.names:
            module_name = alias.name.split('.')[0]
            if module_name not in ALLOWED_MODULES:
                self.errors.append(f"Import interdit: '{alias.name}'. Modules autorisés: {', '.join(sorted(ALLOWED_MODULES))}")
            else:
                self.imports.add(module_name)
        self.generic_visit(node)
    
    def visit_ImportFrom(self, node: ast.ImportFrom):
        """Vérifie les 'from X import Y'"""
        if node.module:
            module_name = node.module.split('.')[0]
            if module_name not in ALLOWED_MODULES:
                self.errors.append(f"Import interdit: 'from {node.module}'. Modules autorisés: {', '.join(sorted(ALLOWED_MODULES))}")
            else:
                self.imports.add(module_name)
        self.generic_visit(node)
    
    def visit_Call(self, node: ast.Call):
        """Vérifie les appels de fonction"""
        # Détecte eval(), exec(), compile(), etc.
        if isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_NAMES:
                self.errors.append(f"Fonction interdite: '{node.func.id}'")
        
        # Détecte os.system(), subprocess.call(), etc.
        if isinstance(node.func, ast.Attribute):
            attr_name = node.func.attr
            if attr_name in {'system', 'popen', 'spawn', 'call', 'run', 'Popen',
                            'listdir', 'remove', 'rmdir', 'unlink', 'makedirs',
                            'environ', 'getenv', 'putenv'}:
                self.errors.append(f"Appel système interdit: '.{attr_name}()'")
        
        self.generic_visit(node)
    
    def visit_Attribute(self, node: ast.Attribute):
        """Vérifie les accès aux attributs dangereux"""
        if node.attr in FORBIDDEN_ATTRS:
            self.errors.append(f"Attribut interdit: '.{node.attr}'")
        
        # Détecte les accès à __dict__, __globals__, etc.
        if node.attr.startswith('__') and node.attr.endswith('__'):
            if node.attr not in {'__name__', '__doc__', '__str__', '__repr__',
                                 '__len__', '__iter__', '__next__', '__getitem__',
                                 '__setitem__', '__contains__', '__add__', '__sub__',
                                 '__mul__', '__truediv__', '__floordiv__', '__mod__',
                                 '__eq__', '__ne__', '__lt__', '__le__', '__gt__', '__ge__',
                                 '__bool__', '__int__', '__float__', '__hash__'}:
                self.errors.append(f"Dunder interdit: '.{node.attr}'")
        
        self.generic_visit(node)
    
    def visit_Name(self, node: ast.Name):
        """Vérifie les noms de variables"""
        if node.id in FORBIDDEN_NAMES:
            self.errors.append(f"Nom interdit: '{node.id}'")
        self.generic_visit(node)
    
    def visit_With(self, node: ast.With):
        """Vérifie les context managers (with open(...) as f)"""
        for item in node.items:
            if isinstance(item.context_expr, ast.Call):
                if isinstance(item.context_expr.func, ast.Name):
                    if item.context_expr.func.id == 'open':
                        self.errors.append("'open()' est interdit. Utilisez les DataFrames fournis.")
        self.generic_visit(node)


def validate_code(code: str) -> List[str]:
    """
    Valide le code Python et retourne la liste des erreurs de sécurité.
    Retourne une liste vide si le code est sûr.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"Erreur de syntaxe: {e}"]
    
    validator = CodeValidator()
    validator.visit(tree)
    
    return validator.errors


# =============================================================================
# Secure Executor
# =============================================================================

@dataclass
class ExecutionResult:
    """Résultat de l'exécution d'un script"""
    success: bool
    output: str
    error: Optional[str] = None
    execution_time: float = 0.0
    result: Any = None


class TimeoutError(Exception):
    """Raised when execution times out"""
    pass


def create_safe_globals(df=None, report_builder=None) -> Dict[str, Any]:
    """
    Crée un environnement d'exécution sécurisé avec seulement
    les fonctions et modules autorisés.
    """
    safe_globals = {'__builtins__': {}}
    
    # Ajoute les builtins autorisés
    import builtins
    for name in ALLOWED_BUILTINS:
        if hasattr(builtins, name):
            safe_globals['__builtins__'][name] = getattr(builtins, name)
    
    # Ajoute les modules autorisés (pré-importés)
    import numpy as np
    import pandas as pd
    import math
    import statistics
    import datetime
    import re
    import json
    from collections import defaultdict, Counter, OrderedDict
    
    safe_globals['np'] = np
    safe_globals['numpy'] = np
    safe_globals['pd'] = pd
    safe_globals['pandas'] = pd
    safe_globals['math'] = math
    safe_globals['statistics'] = statistics
    safe_globals['datetime'] = datetime
    safe_globals['re'] = re
    safe_globals['json'] = json
    safe_globals['defaultdict'] = defaultdict
    safe_globals['Counter'] = Counter
    safe_globals['OrderedDict'] = OrderedDict
    
    # Ajoute les données si fournies
    if df is not None:
        safe_globals['df'] = df
    
    # Ajoute le report builder si fourni
    if report_builder is not None:
        safe_globals['report'] = report_builder
        # Expose les classes du report builder
        safe_globals['Section'] = report_builder.Section
        safe_globals['Text'] = report_builder.Text
        safe_globals['LinePlot'] = report_builder.LinePlot
        safe_globals['Table'] = report_builder.Table
        safe_globals['Callout'] = report_builder.Callout
        safe_globals['Metrics'] = report_builder.Metrics
        safe_globals['ScatterPlot'] = report_builder.ScatterPlot
        safe_globals['Histogram'] = report_builder.Histogram
    
    return safe_globals


def execute_with_timeout(code: str, globals_dict: Dict, timeout_seconds: int = 30) -> ExecutionResult:
    """
    Exécute le code avec un timeout.
    """
    result = ExecutionResult(success=False, output='')
    output_capture = StringIO()
    
    def target():
        nonlocal result
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        
        try:
            sys.stdout = output_capture
            sys.stderr = output_capture
            
            exec(code, globals_dict)
            
            result.success = True
            result.result = globals_dict.get('__result__')
            
        except Exception as e:
            result.error = f"{type(e).__name__}: {str(e)}\n{traceback.format_exc()}"
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            result.output = output_capture.getvalue()
    
    start_time = time.time()
    thread = threading.Thread(target=target)
    thread.daemon = True
    thread.start()
    thread.join(timeout_seconds)
    
    result.execution_time = time.time() - start_time
    
    if thread.is_alive():
        result.success = False
        result.error = f"Timeout: l'exécution a dépassé {timeout_seconds} secondes"
        # Note: On ne peut pas vraiment tuer le thread en Python,
        # mais le flag daemon=True le terminera à la fin du processus principal
    
    return result


def safe_execute(code: str, df=None, report_builder=None, 
                 timeout_seconds: int = 60,
                 max_memory_mb: int = 512) -> ExecutionResult:
    """
    Point d'entrée principal pour exécuter du code de manière sécurisée.
    
    Args:
        code: Le code Python à exécuter
        df: DataFrame pandas avec les données (optionnel)
        report_builder: Instance du ReportBuilder (optionnel)
        timeout_seconds: Timeout en secondes (défaut: 60)
        max_memory_mb: Limite mémoire en MB (non implémenté, pour Docker)
    
    Returns:
        ExecutionResult avec le résultat ou l'erreur
    """
    # Étape 1: Validation statique du code
    errors = validate_code(code)
    if errors:
        return ExecutionResult(
            success=False,
            output='',
            error="Code non autorisé:\n" + "\n".join(f"  • {e}" for e in errors)
        )
    
    # Étape 2: Créer l'environnement sécurisé
    safe_globals = create_safe_globals(df, report_builder)
    
    # Étape 3: Exécuter avec timeout
    return execute_with_timeout(code, safe_globals, timeout_seconds)


# =============================================================================
# Utilitaires
# =============================================================================

def check_code_safety(code: str) -> Dict[str, Any]:
    """
    Vérifie la sécurité du code sans l'exécuter.
    Utile pour la validation côté frontend avant soumission.
    
    Returns:
        {
            'safe': bool,
            'errors': List[str],
            'imports': List[str]
        }
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {
            'safe': False,
            'errors': [f"Erreur de syntaxe ligne {e.lineno}: {e.msg}"],
            'imports': []
        }
    
    validator = CodeValidator()
    validator.visit(tree)
    
    return {
        'safe': len(validator.errors) == 0,
        'errors': validator.errors,
        'imports': list(validator.imports)
    }


# =============================================================================
# Tests
# =============================================================================

if __name__ == '__main__':
    # Test 1: Code sûr
    safe_code = """
import numpy as np
import pandas as pd

result = df['VehicleSpeed'].mean()
print(f"Vitesse moyenne: {result:.2f} km/h")
"""
    
    print("=== Test 1: Code sûr ===")
    check = check_code_safety(safe_code)
    print(f"Safe: {check['safe']}")
    print(f"Imports: {check['imports']}")
    
    # Test 2: Code dangereux
    dangerous_codes = [
        "import os\nos.system('ls')",
        "open('/etc/passwd').read()",
        "eval('1+1')",
        "exec('print(1)')",
        "__import__('os')",
        "[].__class__.__bases__[0].__subclasses__()",
    ]
    
    print("\n=== Test 2: Codes dangereux ===")
    for code in dangerous_codes:
        check = check_code_safety(code)
        print(f"\nCode: {code[:50]}...")
        print(f"Safe: {check['safe']}")
        if check['errors']:
            print(f"Errors: {check['errors']}")