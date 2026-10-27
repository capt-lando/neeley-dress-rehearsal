"""Optional GPU deployment. Deploying incurs compute charges; importing does not."""
from pathlib import Path
import modal

ROOT = Path(__file__).resolve().parent
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install_from_requirements(str(ROOT / "requirements.txt"))
    .add_local_dir(str(ROOT), remote_path="/worker", copy=True,
                   ignore=["models", "__pycache__", ".venv", "tests", "README.md", "modal_app.py"])
    .run_commands("cd /worker && python models.py")
    .env({"PYTHONPATH": "/worker", "HF_HUB_OFFLINE": "1",
          "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"})
)
app = modal.App("neeley-bark-speech")


# Prefer L4, but allow the less expensive T4 when L4 capacity is unavailable.
@app.function(image=image, gpu=["L4", "T4"], cpu=2, memory=8192,
              max_containers=1, scaledown_window=60, timeout=150,
              secrets=[modal.Secret.from_name("neeley-bark-worker")])
@modal.concurrent(max_inputs=8)
@modal.asgi_app(requires_proxy_auth=True)
def speech():
    from server import create_app
    return create_app()
