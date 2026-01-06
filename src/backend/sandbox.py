"""
Secure Script Executor - Sandbox pour exécuter les scripts d'analyse.
Protège contre l'exécution de code malveillant via:
- Validation AST stricte
- Exécution dans un processus séparé (killable)
- Limites de temps et mémoire
- Environnement restreint
"""

import ast
import sys
import time
import multiprocessing
from typing import Dict, Any, Optional, List, Set
from dataclasses import dataclass
from io import StringIO
import traceback
import signal


# --- Configuration de sécurité ---

ALLOWED_MODULES = {
    'numpy', 'np',
    'pandas', 'pd',
    'statistics',
    'math',
    'decimal',
    'fractions',
    'collections',
    'itertools',
    'functools',
    'datetime',
    're',
    'string',
    'json',
    'typing',
}

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
    'isinstance', 'issubclass', 'hasattr',
    'callable', 'iter', 'next',
    # Conversion
    'bin', 'hex', 'oct', 'ord', 'chr',
    'format', 'repr', 'ascii',
    # Autres
    'print', 'id', 'hash',
    'slice', 'property', 'staticmethod', 'classmethod',
    'super',
    # Exceptions
    'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
    'AttributeError', 'RuntimeError', 'StopIteration', 'ZeroDivisionError',
}

# Attributs toujours interdits (accès introspection dangereuse)
FORBIDDEN_ATTRS = {
    '__import__', '__loader__', '__spec__',
    '__builtins__', '__globals__', '__locals__',
    '__code__', '__closure__', '__func__',
    '__self__', '__dict__', '__class__', '__bases__', '__mro__',
    '__subclasses__', '__init_subclass__', '__reduce__', '__reduce_ex__',
    '_getframe', '_current_frames',
    'gi_frame', 'gi_code', 'f_globals', 'f_locals', 'f_code', 'f_back',
    'co_code', 'func_globals', 'func_code',
    'tb_frame', 'tb_next',
}

FORBIDDEN_NAMES = {
    'eval', 'exec', 'compile', 'execfile',
    'open', 'file', 'input', 'raw_input',
    'reload', '__import__',
    'globals', 'locals', 'vars', 'dir',
    'getattr', 'setattr', 'delattr',
    'memoryview', 'bytearray',
    'breakpoint', 'credits', 'license', 'copyright',
    'exit', 'quit', 'help',
}

# Limite de complexité du code
MAX_AST_NODES = 10000
MAX_STRING_LENGTH = 100000
MAX_CODE_LENGTH = 500000


# --- Exceptions ---

class UnsafeCodeError(Exception):
    """Code dangereux détecté."""
    pass


class ExecutionTimeoutError(Exception):
    """Timeout d'exécution."""
    pass


class MemoryLimitError(Exception):
    """Limite mémoire dépassée."""
    pass


# --- AST Validator ---

class CodeValidator(ast.NodeVisitor):
    """Validateur AST pour détecter le code dangereux."""

    def __init__(self):
        self.errors: List[str] = []
        self.imports: Set[str] = set()
        self.node_count = 0

    def visit(self, node):
        self.node_count += 1
        if self.node_count > MAX_AST_NODES:
            self.errors.append(f"Code trop complexe (>{MAX_AST_NODES} nodes AST)")
            return
        return super().visit(node)

    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            module_name = alias.name.split('.')[0]
            if module_name not in ALLOWED_MODULES:
                self.errors.append(
                    f"Import interdit: '{alias.name}'"
                )
            else:
                self.imports.add(module_name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom):
        if node.module:
            module_name = node.module.split('.')[0]
            if module_name not in ALLOWED_MODULES:
                self.errors.append(
                    f"Import interdit: 'from {node.module}'"
                )
            else:
                self.imports.add(module_name)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call):
        if isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_NAMES:
                self.errors.append(f"Fonction interdite: '{node.func.id}'")

        if isinstance(node.func, ast.Attribute):
            attr_name = node.func.attr
            dangerous_methods = {
                'system', 'popen', 'spawn', 'call', 'run', 'Popen',
                'listdir', 'remove', 'rmdir', 'unlink', 'makedirs', 'mkdir',
                'environ', 'getenv', 'putenv',
                'load', 'loads', 'dump', 'dumps',  # Pickle
                'read', 'write', 'readline', 'readlines',  # File ops
            }
            if attr_name in dangerous_methods:
                # Vérifie si c'est json.loads/dumps (autorisé)
                if isinstance(node.func.value, ast.Name):
                    if node.func.value.id == 'json' and attr_name in {'loads', 'dumps', 'load', 'dump'}:
                        pass  # OK pour json
                    else:
                        self.errors.append(f"Méthode potentiellement dangereuse: '.{attr_name}()'")
                else:
                    self.errors.append(f"Méthode potentiellement dangereuse: '.{attr_name}()'")

        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute):
        if node.attr in FORBIDDEN_ATTRS:
            self.errors.append(f"Attribut interdit: '.{node.attr}'")

        # Bloque tous les dunders sauf une liste blanche très restreinte
        if node.attr.startswith('__') and node.attr.endswith('__'):
            allowed_dunders = {
                '__name__', '__doc__', '__str__', '__repr__',
                '__len__', '__iter__', '__next__',
                '__add__', '__sub__', '__mul__', '__truediv__', '__floordiv__', '__mod__',
                '__eq__', '__ne__', '__lt__', '__le__', '__gt__', '__ge__',
                '__bool__', '__int__', '__float__', '__abs__', '__neg__', '__pos__',
            }
            if node.attr not in allowed_dunders:
                self.errors.append(f"Attribut dunder interdit: '.{node.attr}'")

        self.generic_visit(node)

    def visit_Name(self, node: ast.Name):
        if node.id in FORBIDDEN_NAMES:
            self.errors.append(f"Nom interdit: '{node.id}'")
        # Bloque l'accès direct aux dunders
        if node.id.startswith('__') and node.id.endswith('__'):
            self.errors.append(f"Nom dunder interdit: '{node.id}'")
        self.generic_visit(node)

    def visit_Str(self, node: ast.Str):
        # Python < 3.8
        if len(node.s) > MAX_STRING_LENGTH:
            self.errors.append(f"Chaîne trop longue (>{MAX_STRING_LENGTH} chars)")
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant):
        # Python >= 3.8
        if isinstance(node.value, str) and len(node.value) > MAX_STRING_LENGTH:
            self.errors.append(f"Chaîne trop longue (>{MAX_STRING_LENGTH} chars)")
        self.generic_visit(node)

    def visit_With(self, node: ast.With):
        for item in node.items:
            if isinstance(item.context_expr, ast.Call):
                if isinstance(item.context_expr.func, ast.Name):
                    if item.context_expr.func.id == 'open':
                        self.errors.append("'open()' interdit")
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self.errors.append("Fonctions async interdites")
        self.generic_visit(node)

    def visit_Await(self, node: ast.Await):
        self.errors.append("await interdit")
        self.generic_visit(node)

    def visit_Lambda(self, node: ast.Lambda):
        # Lambda autorisé mais on visite quand même le body
        self.generic_visit(node)

    def visit_Global(self, node: ast.Global):
        self.errors.append("'global' interdit")
        self.generic_visit(node)

    def visit_Nonlocal(self, node: ast.Nonlocal):
        self.errors.append("'nonlocal' interdit")
        self.generic_visit(node)


def validate_code(code: str) -> List[str]:
    """Valide le code Python et retourne la liste des erreurs."""
    if len(code) > MAX_CODE_LENGTH:
        return [f"Code trop long (>{MAX_CODE_LENGTH} caractères)"]

    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"Erreur de syntaxe ligne {e.lineno}: {e.msg}"]

    validator = CodeValidator()
    validator.visit(tree)

    return validator.errors


# --- Secure Executor ---

@dataclass
class ExecutionResult:
    """Résultat de l'exécution d'un script."""
    success: bool
    output: str
    error: Optional[str] = None
    execution_time: float = 0.0
    result: Any = None


def _set_resource_limits(max_memory_mb: int, max_cpu_seconds: int):
    """Configure les limites de ressources (Linux uniquement)."""
    try:
        import resource
        # Limite mémoire (soft, hard)
        memory_bytes = max_memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
        # Limite CPU
        resource.setrlimit(resource.RLIMIT_CPU, (max_cpu_seconds, max_cpu_seconds))
    except (ImportError, ValueError, OSError):
        # Windows ou autre OS sans resource
        pass


def _execution_worker(code: str, data_dict: Optional[Dict], 
                      result_queue: multiprocessing.Queue,
                      max_memory_mb: int, max_cpu_seconds: int):
    """Worker qui exécute le code dans un processus isolé."""
    _set_resource_limits(max_memory_mb, max_cpu_seconds)

    output_capture = StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr

    try:
        sys.stdout = output_capture
        sys.stderr = output_capture

        safe_globals = _create_safe_globals(data_dict)
        exec(code, safe_globals)

        result_queue.put({
            'success': True,
            'output': output_capture.getvalue(),
            'result': safe_globals.get('__result__'),
            'error': None
        })

    except MemoryError:
        result_queue.put({
            'success': False,
            'output': output_capture.getvalue(),
            'result': None,
            'error': "Limite mémoire dépassée"
        })
    except Exception as e:
        result_queue.put({
            'success': False,
            'output': output_capture.getvalue(),
            'result': None,
            'error': f"{type(e).__name__}: {str(e)}"
        })
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr


def _create_safe_globals(data_dict: Optional[Dict] = None) -> Dict[str, Any]:
    """Crée un environnement d'exécution sécurisé."""
    safe_globals = {'__builtins__': {}}

    # Ajoute les builtins autorisés
    import builtins
    for name in ALLOWED_BUILTINS:
        if hasattr(builtins, name):
            safe_globals['__builtins__'][name] = getattr(builtins, name)

    # Ajoute les modules autorisés
    import numpy as np
    import pandas as pd
    import math
    import statistics
    import datetime
    import re
    import json as json_module
    from collections import defaultdict, Counter, OrderedDict

    safe_globals['np'] = np
    safe_globals['numpy'] = np
    safe_globals['pd'] = pd
    safe_globals['pandas'] = pd
    safe_globals['math'] = math
    safe_globals['statistics'] = statistics
    safe_globals['datetime'] = datetime
    safe_globals['re'] = re
    safe_globals['json'] = json_module
    safe_globals['defaultdict'] = defaultdict
    safe_globals['Counter'] = Counter
    safe_globals['OrderedDict'] = OrderedDict

    # Ajoute les données fournies
    if data_dict:
        for key, value in data_dict.items():
            safe_globals[key] = value

    return safe_globals


def safe_execute(code: str, 
                 data: Optional[Dict[str, Any]] = None,
                 timeout_seconds: int = 30,
                 max_memory_mb: int = 256) -> ExecutionResult:
    """
    Exécute du code de manière sécurisée dans un processus isolé.

    Args:
        code: Le code Python à exécuter
        data: Dictionnaire de données à injecter (ex: {'df': dataframe})
        timeout_seconds: Timeout en secondes (défaut: 30)
        max_memory_mb: Limite mémoire en MB (défaut: 256)

    Returns:
        ExecutionResult avec le résultat ou l'erreur
    """
    # Étape 1: Validation statique
    errors = validate_code(code)
    if errors:
        return ExecutionResult(
            success=False,
            output='',
            error="Code non autorisé:\n" + "\n".join(f"  • {e}" for e in errors)
        )

    # Étape 2: Exécution dans un processus séparé
    result_queue = multiprocessing.Queue()
    start_time = time.time()

    # Sérialise les données (attention: les gros DataFrames peuvent être lents)
    # Pour de meilleures perfs, considérer shared memory ou fichiers temporaires
    serializable_data = None
    if data:
        try:
            # On passe un dict simple, pas les objets complexes directement
            serializable_data = data
        except Exception:
            pass

    process = multiprocessing.Process(
        target=_execution_worker,
        args=(code, serializable_data, result_queue, max_memory_mb, timeout_seconds + 5)
    )
    process.start()
    process.join(timeout_seconds)

    execution_time = time.time() - start_time

    if process.is_alive():
        process.terminate()
        process.join(1)
        if process.is_alive():
            process.kill()

        return ExecutionResult(
            success=False,
            output='',
            error=f"Timeout: l'exécution a dépassé {timeout_seconds} secondes",
            execution_time=execution_time
        )

    # Récupère le résultat
    try:
        if not result_queue.empty():
            result_data = result_queue.get_nowait()
            return ExecutionResult(
                success=result_data['success'],
                output=result_data['output'],
                error=result_data['error'],
                result=result_data['result'],
                execution_time=execution_time
            )
        else:
            return ExecutionResult(
                success=False,
                output='',
                error="Aucun résultat retourné par le worker",
                execution_time=execution_time
            )
    except Exception as e:
        return ExecutionResult(
            success=False,
            output='',
            error=f"Erreur de communication: {str(e)}",
            execution_time=execution_time
        )


def check_code_safety(code: str) -> Dict[str, Any]:
    """
    Vérifie la sécurité du code sans l'exécuter.
    Utile pour validation côté frontend.
    """
    if len(code) > MAX_CODE_LENGTH:
        return {
            'safe': False,
            'errors': [f"Code trop long (>{MAX_CODE_LENGTH} caractères)"],
            'imports': []
        }

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


# --- Point d'entrée pour compatibilité ---

def create_safe_globals(df=None, report_builder=None) -> Dict[str, Any]:
    """Compatibilité avec l'ancienne API."""
    data = {}
    if df is not None:
        data['df'] = df
    if report_builder is not None:
        data['report'] = report_builder
    return _create_safe_globals(data)


# --- Tests ---

if __name__ == '__main__':
    print("=== Test 1: Code sûr ===")
    safe_code = """
import numpy as np
result = np.mean([1, 2, 3, 4, 5])
print(f"Moyenne: {result}")
__result__ = result
"""
    result = safe_execute(safe_code)
    print(f"Success: {result.success}")
    print(f"Output: {result.output}")
    print(f"Result: {result.result}")
    print(f"Time: {result.execution_time:.2f}s")

    print("\n=== Test 2: Code avec timeout ===")
    timeout_code = """
while True:
    pass
"""
    result = safe_execute(timeout_code, timeout_seconds=2)
    print(f"Success: {result.success}")
    print(f"Error: {result.error}")

    print("\n=== Test 3: Code interdit ===")
    dangerous_codes = [
        "import os",
        "open('/etc/passwd')",
        "eval('1+1')",
        "__import__('os')",
        "[].__class__.__bases__",
        "globals()",
    ]
    for code in dangerous_codes:
        check = check_code_safety(code)
        status = "✓ Bloqué" if not check['safe'] else "✗ DANGER"
        print(f"{status}: {code[:40]}")
        if check['errors']:
            print(f"         → {check['errors'][0]}")