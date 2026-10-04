import json
import os
import re
import sys
import warnings
from pathlib import Path

import pytest

warnings.filterwarnings("ignore")
# Hermetic: a developer's real .env / SMTP settings must never make a test send an email.
os.environ["ROADMIND_ENV_FILE"] = ""
for _name in [n for n in os.environ if n.startswith("ROADMIND_SMTP")]:
    del os.environ[_name]
BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import REPO_ROOT, load_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from osm_fixture import make_extract  # noqa: E402

# bounding box that contains the whole fixture grid
GRID = (13.058, 80.248, 13.085, 80.285)


@pytest.fixture(scope="session")
def app(tmp_path_factory):
    data = tmp_path_factory.mktemp("roadmind")
    extract_path = data / "grid.json"
    extract_path.write_text(json.dumps(make_extract()), encoding="utf-8")
    # hermetic: a fixture network instead of the bundled extract, and no calls to external services
    # (guests may submit reports in this shared app so the pipeline tests stay simple; test_auth.py covers the default, where they may not)
    settings = load_settings(
        {"data_dir": data, "network": {"source_file": str(extract_path), "remote_enabled": False},
         "auth": {"setup_local_only": False, "require_login_to_report": False}}
    )
    settings.geocoding.nominatim_enabled = False
    # keep the model artifacts in the temp folder too: the app trains a fresh risk model on start-up
    settings.risk.model_path = str(data / "risk_model.joblib")
    settings.risk.metrics_path = str(data / "risk_metrics.json")
    return create_app(settings)


ADMIN = {"full_name": "Test Administrator", "email": "admin@example.org", "password": "Correct-Horse-9", "confirm_password": "Correct-Horse-9"}
USER = {"full_name": "Test Citizen", "email": "citizen@example.org", "password": "Another-Strong-7", "confirm_password": "Another-Strong-7"}
STAFF = {"full_name": "Test Mechanic", "email": "crew@example.org", "role": "maintenance"}
STAFF_PASSWORD = "Violet-Harbor-Pass-3"


def email_token(c, param: str) -> str:
    """The token in the newest message in the app's outbox whose link points at `param` (verify-email, accept-invite,
    reset-password) - what a person would click in the email."""
    for f in sorted((c.app.state.settings.data_dir / "outbox").glob("*.txt"), reverse=True):
        m = re.search(rf"{param}\?token=([\w-]+)", f.read_text(encoding="utf-8"))
        if m:
            return m.group(1)
    raise AssertionError(f"no {param} email in the outbox")


def verify_admin(c, body=ADMIN) -> None:
    """Complete the initial-administrator flow: setup, then open the emailed verification link."""
    r = c.post("/api/auth/setup", json=body)
    assert r.status_code == 201, r.text
    v = c.post("/api/auth/verify-email", json={"token": email_token(c, "verify-email")})
    assert v.status_code == 200, v.text


@pytest.fixture(scope="session")
def client(app):
    with TestClient(app) as c:
        # there is no built-in account: the administrator is created through first-run setup and verified by email,
        # exactly like a real install
        verify_admin(c)
        yield c


def _bearer(r):
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="session")
def admin_headers(client):
    return _bearer(client.post("/api/auth/staff/login", json={"identifier": ADMIN["email"], "password": ADMIN["password"]}))


@pytest.fixture(scope="session")
def user_headers(client):
    """A normal (non-admin) account."""
    r = client.post("/api/auth/register", json=USER)
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="session")
def staff(client, admin_headers):
    """A maintenance employee, created the real way: an administrator invites them, they accept and set a password."""
    r = client.post("/api/admin/users", json=STAFF, headers=admin_headers)
    assert r.status_code == 201, r.text
    ok = client.post("/api/auth/accept-invite", json={"token": email_token(client, "accept-invite"), "new_password": STAFF_PASSWORD, "confirm_password": STAFF_PASSWORD})
    assert ok.status_code == 200, ok.text
    headers = _bearer(client.post("/api/auth/staff/login", json={"identifier": STAFF["email"], "password": STAFF_PASSWORD}))
    return {"id": r.json()["id"], "headers": headers}


@pytest.fixture(scope="session")
def sample_image() -> bytes:
    """A generated road photo containing exactly one pothole (no files needed on disk)."""
    import cv2
    from roadmind_ai.detection.synthetic import generate_image

    for seed in range(500):
        img, truth = generate_image(seed, n_elements=1)
        if truth and truth[0].label == "pothole":
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            assert ok
            return buf.tobytes()
    pytest.fail("could not generate a pothole image")


@pytest.fixture(scope="session")
def risk_predictor(tmp_path_factory):
    """A risk model trained into a temp folder, so the tests never depend on ai/models/ contents."""
    from roadmind_ai.prediction import RiskPredictor
    from roadmind_ai.prediction.train import train

    folder = tmp_path_factory.mktemp("risk")
    train(folder / "model.joblib", folder / "metrics.json")
    return RiskPredictor.load(folder / "model.joblib")


@pytest.fixture(scope="session")
def places(client):
    return {p["name"]: p for p in client.get("/api/routes/places").json()["places"]}


def view(client, zoom: int = 16, box=GRID) -> dict:
    s, w, n, e = box
    r = client.get("/api/network", params={"south": s, "west": w, "north": n, "east": e, "zoom": zoom})
    assert r.status_code == 200, r.text
    return r.json()
