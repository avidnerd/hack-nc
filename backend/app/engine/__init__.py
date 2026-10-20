"""Deterministic Python port of the browser's planning engine (src/planning,
src/devices) and the agent tool executor built on it. Used by the distillation
pipeline and eval to run tools without a browser; tests/test_engine_parity.py
pins it to the TS engine.
"""

from .grid import Case, load_case
from .session import Session
from .tools import execute

__all__ = ["Case", "Session", "execute", "load_case"]
