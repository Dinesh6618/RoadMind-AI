"""RoadMind AI - computer-vision and machine-learning modules.

This package is deliberately independent of the web backend: it has no FastAPI or
database imports, so the models can be trained, evaluated and swapped on their own.
"""

from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
AI_DIR = PACKAGE_DIR.parent
MODELS_DIR = AI_DIR / "models"
