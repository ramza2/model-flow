#!/usr/bin/env python3
"""Validate docker compose config published host ports (stdlib only)."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path


def main() -> int:
    config_path = Path(sys.argv[1] if len(sys.argv) > 1 else "/config.yml")
    text = config_path.read_text(encoding="utf-8")
    checks = [
        ("postgres", os.environ["POSTGRES_HOST_PORT"], "5432"),
        ("postgres-source", os.environ["SOURCE_POSTGRES_HOST_PORT"], "5432"),
        ("minio", os.environ["MINIO_API_HOST_PORT"], "9000"),
        ("minio", os.environ["MINIO_CONSOLE_HOST_PORT"], "9001"),
        ("mlflow", os.environ["MLFLOW_HOST_PORT"], "5000"),
        ("backend", os.environ["BACKEND_HOST_PORT"], "8000"),
        ("frontend", os.environ["FRONTEND_HOST_PORT"], "80"),
    ]
    for service, published, target in checks:
        pattern = re.compile(
            rf"published:\s*[\"']?{re.escape(published)}[\"']?\s*\n\s*target:\s*{re.escape(target)}"
            rf"|target:\s*{re.escape(target)}\s*\n\s*published:\s*[\"']?{re.escape(published)}[\"']?"
        )
        if not pattern.search(text):
            print(
                f"{service}: missing published={published} target={target} pairing",
                file=sys.stderr,
            )
            return 1
    if "MLFLOW_TRACKING_URI: http://mlflow:5000" not in text:
        print("backend must still reach MLflow at mlflow:5000", file=sys.stderr)
        return 1
    if "MINIO_ENDPOINT: minio:9000" not in text:
        print("backend must still reach MinIO at minio:9000", file=sys.stderr)
        return 1
    if "@postgres:5432/" not in text:
        print("backend must still reach Postgres at postgres:5432", file=sys.stderr)
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
