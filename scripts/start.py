"""One-command launcher: prepares demo artifacts if missing, then serves API + built frontend.

    python scripts/start.py [--port 8000] [--reload]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--reload", action="store_true", help="auto-restart on backend code changes")
    args = ap.parse_args()

    if not (ROOT / "ai" / "models" / "risk_model.joblib").exists() or not (ROOT / "data" / "sample_images").exists():
        print("First run: generating sample images and training the demo models...")
        subprocess.run([sys.executable, str(ROOT / "scripts" / "setup_demo.py")], check=True)

    dist = ROOT / "frontend" / "dist"
    if not dist.exists():
        npm = shutil.which("npm")
        if npm:
            print("Building the frontend (first run)...")
            subprocess.run([npm, "install", "--no-audit", "--no-fund"], cwd=ROOT / "frontend", check=True)
            subprocess.run([npm, "run", "build"], cwd=ROOT / "frontend", check=True)
        else:
            print("npm not found - serving the API only. Install Node.js and run `npm run build` in frontend/.")

    sys.path.insert(0, str(ROOT / "backend"))
    import uvicorn

    print(f"\nRoadMind AI -> http://{args.host}:{args.port}   (API docs: /api/docs)")
    print("There is no default login. Open the site and choose 'Who are you?': users go to /user/login, administrators and")
    print("road-maintenance staff to the Admin Portal (/admin/portal: Login or Create Account - new accounts need an administrator's approval).")
    print("On a fresh install, choose the admin door on THIS computer to create the initial administrator.\n")
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=args.reload, reload_dirs=[str(ROOT / "backend"), str(ROOT / "ai")] if args.reload else None)


if __name__ == "__main__":
    main()
