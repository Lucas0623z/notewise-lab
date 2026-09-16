import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    max_upload_bytes: int = 100 * 1024 * 1024
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")

    @classmethod
    def from_env(cls):
        origins = os.environ.get("STUDIO_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
        return cls(
            data_dir=Path(os.environ.get("STUDIO_DATA_DIR", "data")).resolve(),
            max_upload_bytes=int(os.environ.get("STUDIO_MAX_UPLOAD_MB", "100")) * 1024 * 1024,
            cors_origins=tuple(x.strip() for x in origins.split(",") if x.strip()),
        )

