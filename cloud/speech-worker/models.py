"""Only image builds download model assets; serving is offline."""
import hashlib
from pathlib import Path

BARK_REPO = "ConwayResearch/Underdog-Bark-3.0-Plus"
BARK_REVISION = "d4fab2f8b95681e5ad3cfb4e8c5f4e0c009b3deb"
PROCESSOR_REPO = "nvidia/parakeet-tdt-0.6b-v3"
PROCESSOR_REVISION = "541d1f99c6b0c3cd0b11a95167540bb8edefd82b"
LOADER_SHA256 = "e86b7f130bec1a8fa14dd315cfce95785b890dbd30000f6ceb2597fdd4312b02"
MODEL_ROOT = Path(__file__).resolve().parent / "models"


def verify_loader(path):
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != LOADER_SHA256:
        raise RuntimeError("The pinned model loader failed integrity validation.")


def download():
    from huggingface_hub import snapshot_download
    snapshot_download(BARK_REPO, revision=BARK_REVISION,
                      local_dir=MODEL_ROOT / "bark",
                      allow_patterns=["model.bark", "bark_loader.py", "NOTICE"])
    verify_loader(MODEL_ROOT / "bark" / "bark_loader.py")
    snapshot_download(PROCESSOR_REPO, revision=PROCESSOR_REVISION,
                      local_dir=MODEL_ROOT / "processor",
                      allow_patterns=["config.json", "generation_config.json", "processor_config.json",
                                      "tokenizer.json", "tokenizer_config.json"])


if __name__ == "__main__":
    download()
