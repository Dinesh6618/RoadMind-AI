"""RoadMind AI backend (FastAPI)."""

import sys
from pathlib import Path

# The AI package lives in ../ai (kept separate from the API on purpose). Make it importable
# without requiring an install step.
_AI_DIR = Path(__file__).resolve().parents[2] / "ai"
if str(_AI_DIR) not in sys.path:
    sys.path.insert(0, str(_AI_DIR))
