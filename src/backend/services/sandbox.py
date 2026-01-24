"""
Baltimore Bird - Sandbox pour exécution sécurisée de scripts.

Protège contre l'exécution de code malveillant via:
- Validation AST stricte
- Exécution dans un processus séparé
- Limites de temps et mémoire
- Environnement restreint
"""

import ast
import multiprocessing
import sys
import time
from dataclasses import dataclass
from io import StringIO
from typing import Any, Dict, List, Optional, Set

try:
    import resource
    HAS_RESOURCE = True
except ImportError:
    HAS_RESOURCE = False

from config import SANDBOX_MAX_AST_NODES, SANDBOX_MAX_CODE_LENGTH, SANDBOX_MAX_STRING_LENGTH


ALLOWED_MODULES: Set[str] = {
    "numpy", "np",
    "pandas", "pd",
    "statistics",
    "math",
    "decimal",
    "fractions",
    "collections",
    "itertools",
    "functools",
    "datetime",
    "re",
    "string",
    "json",
    "typing",
}

ALLOWED_BUILTINS: Set[str] = {
    "int", "float", "str", "bool", "bytes",
    "list", "dict", "set", "tuple", "frozenset",
    "type", "object",
    "len", "range", "enumerate", "zip", "map", "filter",
    "sorted", "reversed", "min", "max", "sum", "abs",
    "round", "pow", "divmod",
    "all", "any",
    "isinstance", "issubclass", "hasattr",
    "callable", "iter", "next",
    "bin", "hex", "oct", "ord", "chr",
    "format", "repr", "ascii",
    "print", "id", "hash",
    "slice", "property", "staticmethod", "classmethod",
    "super",
    "Exception", "ValueError", "TypeError", "KeyError", "IndexError",
    "AttributeError", "RuntimeError", "StopIteration", "ZeroDivisionError",
}

FORBIDDEN_ATTRS: Set[str] = {
    "__import__", "__loader__", "__spec__",
    "__builtins__", "__globals__", "__locals__",
    "__code__", "__closure__", "__func__",
    "__self__", "__dict__", "__class__", "__bases__", "__mro__",
    "__subclasses__", "__init_subclass__", "__reduce__", "__reduce_ex__",
    "_getframe", "_current_frames",
    "gi_frame", "gi_code", "f_globals", "f_locals", "f_code", "f_back",
    "co_code", "func_globals", "func_code",
    "tb_frame", "tb_next",
}

FORBIDDEN_NAMES: Set[str] = {
    "eval", "exec", "compile", "execfile",
    "open", "file", "input", "raw_input",
    "reload", "__import__",
    "globals", "locals", "vars", "dir",
    "getattr", "setattr", "delattr",
    "memoryview", "bytearray",
    "breakpoint", "credits", "license", "copyright",
    "exit", "quit", "help",
}


@dataclass
class ExecutionResult:
    """Résultat d'une exécution sandbox."""
    success: bool
    output: str
    error: Optional[str] = None
    result: Any = None
    execution_time: float = 0.0


class CodeValidator(ast.NodeVisitor):
    """Validateur AST pour détecter le code dangereux."""

    def __init__(self):
        self.errors: List[str] = []
        self.imports: Set[str] = set()
        self.node_count = 0

    def visit(self, node: ast.AST) -> Any:
        self.node_count += 1
        if self.node_count > SANDBOX_MAX_AST_NODES:
            self.errors.append(f"Code trop complexe (>{SANDBOX_MAX_AST_NODES} nodes AST)")
            return
        return super().visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            module_name = alias.name.split(".")[0]
            if module_name not in ALLOWED_MODULES:
                self.errors.append(f"Import interdit: '{alias.name}'")
            else:
                self.imports.add(module_name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module:
            module_name = node.module.split(".")[0]
            if module_name not in ALLOWED_MODULES:
                self.errors.append(f"Import interdit: 'from {node.module}'")
            else:
                self.imports.add(module_name)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_NAMES:
                self.errors.append(f"Fonction interdite: '{node.func.id}'")

        if isinstance(node.func, ast.Attribute):
            attr_name = node.func.attr
            dangerous_methods = {
                "system", "popen", "spawn", "call", "run", "Popen",
                "listdir", "remove", "rmdir", "unlink", "makedirs", "mkdir",
                "environ", "getenv", "putenv",
                "load", "loads", "dump", "dumps",
                "read", "write", "readline", "readlines",
            }
            if attr_name in dangerous_methods:
                if isinstance(node.func.value, ast.Name):
                    if node.func.value.id == "json" and attr_name in {"loads", "dumps", "load", "dump"}:
                        pass
                    else:
                        self.errors.append(f"Méthode potentiellement dangereuse: '.{attr_name}()'")
                else:
                    self.errors.append(f"Méthode potentiellement dangereuse: '.{attr_name}()'")

        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in FORBIDDEN_ATTRS:
            self.errors.append(f"Attribut interdit: '.{node.attr}'")

        if node.attr.startswith("__") and node.attr.endswith("__"):
            allowed_dunders = {
                "__name__", "__doc__", "__str__", "__repr__",
                "__len__", "__iter__", "__next__",
                "__add__", "__sub__", "__mul__", "__truediv__", "__floordiv__", "__mod__",
                "__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__",
                "__bool__", "__int__", "__float__", "__abs__", "__neg__", "__pos__",
            }
            if node.attr not in allowed_dunders:
                self.errors.append(f"Attribut dunder interdit: '.{node.attr}'")

        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in FORBIDDEN_NAMES:
            self.errors.append(f"Nom interdit: '{node.id}'")
        if node.id.startswith("__") and node.id.endswith("__"):
            self.errors.append(f"Nom dunder interdit: '{node.id}'")
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str) and len(node.value) > SANDBOX_MAX_STRING_LENGTH:
            self.errors.append(f"Chaîne trop longue (>{SANDBOX_MAX_STRING_LENGTH} chars)")
        self.generic_visit(node)

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            if isinstance(item.context_expr, ast.Call):
                if isinstance(item.context_expr.func, ast.Name):
                    if item.context_expr.func.id == "open":
                        self.errors.append("'open()' interdit")
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.errors.append("Fonctions async interdites")
        self.generic_visit(node)

    def visit_Await(self, node: ast.Await) -> None:
        self.errors.append("await interdit")
        self.generic_visit(node)

    def visit_Global(self, node: ast.Global) -> None:
        self.errors.append("'global' interdit")
        self.generic_visit(node)

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.errors.append("'nonlocal' interdit")
        self.generic_visit(node)


def validate_code(code: str) -> List[str]:
    """Valide le code Python et retourne la liste des erreurs."""
    if len(code) > SANDBOX_MAX_CODE_LENGTH:
        return [f"Code trop long (>{SANDBOX_MAX_CODE_LENGTH} caractères)"]

    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"Erreur de syntaxe ligne {e.lineno}: {e.msg}"]

    validator = CodeValidator()
    validator.visit(tree)

    return validator.errors


def check_code_safety(code: str) -> Dict[str, Any]:
    """Vérifie la sécurité du code sans l'exécuter."""
    if len(code) > SANDBOX_MAX_CODE_LENGTH:
        return {
            "safe": False,
            "errors": [f"Code trop long (>{SANDBOX_MAX_CODE_LENGTH} caractères)"],
            "imports": []
        }

    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {
            "safe": False,
            "errors": [f"Erreur de syntaxe ligne {e.lineno}: {e.msg}"],
            "imports": []
        }

    validator = CodeValidator()
    validator.visit(tree)

    return {
        "safe": len(validator.errors) == 0,
        "errors": validator.errors,
        "imports": list(validator.imports)
    }


def _create_safe_globals(data_dict: Optional[Dict] = None) -> Dict[str, Any]:
    """Crée un environnement d'exécution sécurisé."""
    safe_globals: Dict[str, Any] = {"__builtins__": {}}

    import builtins
    for name in ALLOWED_BUILTINS:
        if hasattr(builtins, name):
            safe_globals["__builtins__"][name] = getattr(builtins, name)

    import datetime
    import json as json_module
    import math
    import re
    import statistics
    from collections import Counter, OrderedDict, defaultdict

    import numpy as np
    import pandas as pd

    safe_globals["np"] = np
    safe_globals["numpy"] = np
    safe_globals["pd"] = pd
    safe_globals["pandas"] = pd
    safe_globals["math"] = math
    safe_globals["statistics"] = statistics
    safe_globals["datetime"] = datetime
    safe_globals["re"] = re
    safe_globals["json"] = json_module
    safe_globals["defaultdict"] = defaultdict
    safe_globals["Counter"] = Counter
    safe_globals["OrderedDict"] = OrderedDict

    if data_dict:
        for key, value in data_dict.items():
            safe_globals[key] = value

    return safe_globals


def _execution_worker(
    code: str,
    data_dict: Optional[Dict],
    result_queue: multiprocessing.Queue,
    max_memory_mb: int,
    timeout: int
) -> None:
    """Worker d'exécution dans un processus séparé."""
    if HAS_RESOURCE:
        try:
            soft_limit = max_memory_mb * 1024 * 1024
            hard_limit = soft_limit * 2
            resource.setrlimit(resource.RLIMIT_AS, (soft_limit, hard_limit))
        except Exception:
            pass

    output_capture = StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr

    try:
        sys.stdout = output_capture
        sys.stderr = output_capture

        safe_globals = _create_safe_globals(data_dict)
        exec(code, safe_globals)

        result_queue.put({
            "success": True,
            "output": output_capture.getvalue(),
            "result": safe_globals.get("__result__"),
            "error": None
        })

    except MemoryError:
        result_queue.put({
            "success": False,
            "output": output_capture.getvalue(),
            "result": None,
            "error": "Limite mémoire dépassée"
        })
    except Exception as e:
        result_queue.put({
            "success": False,
            "output": output_capture.getvalue(),
            "result": None,
            "error": f"{type(e).__name__}: {str(e)}"
        })
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr


def safe_execute(
    code: str,
    data: Optional[Dict[str, Any]] = None,
    timeout_seconds: int = 30,
    max_memory_mb: int = 256
) -> ExecutionResult:
    """Exécute du code de manière sécurisée dans un processus isolé."""
    errors = validate_code(code)
    if errors:
        return ExecutionResult(
            success=False,
            output="",
            error="Code non autorisé:\n" + "\n".join(f"  - {e}" for e in errors)
        )

    result_queue: multiprocessing.Queue = multiprocessing.Queue()
    start_time = time.time()

    process = multiprocessing.Process(
        target=_execution_worker,
        args=(code, data, result_queue, max_memory_mb, timeout_seconds + 5)
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
            output="",
            error=f"Timeout: l'exécution a dépassé {timeout_seconds} secondes",
            execution_time=execution_time
        )

    try:
        if not result_queue.empty():
            result_data = result_queue.get_nowait()
            return ExecutionResult(
                success=result_data["success"],
                output=result_data["output"],
                error=result_data["error"],
                result=result_data["result"],
                execution_time=execution_time
            )
        else:
            return ExecutionResult(
                success=False,
                output="",
                error="Aucun résultat retourné par le worker",
                execution_time=execution_time
            )
    except Exception as e:
        return ExecutionResult(
            success=False,
            output="",
            error=f"Erreur de communication: {str(e)}",
            execution_time=execution_time
        )