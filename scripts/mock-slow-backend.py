#!/usr/bin/env python3
"""Minimal upstream for frontend/nginx Copilot proxy_read_timeout checks.

No LLM calls. Sleeps only on selected paths so nginx timeout behavior can be
asserted through the real frontend/nginx.conf.
"""

from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

COPILOT_PATH_RE = re.compile(r"^/api/v1/projects/[0-9]+/pipeline-copilot/(draft|patch)$")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    def _write(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        self._handle()

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length:
            self.rfile.read(length)
        self._handle()

    def _handle(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        echo = {
            "path": path,
            "query": {key: values[0] if len(values) == 1 else values for key, values in query.items()},
            "method": self.command,
        }

        if COPILOT_PATH_RE.match(path):
            delay = float(query.get("delay", ["65"])[0])
            threading.Event().wait(delay)
            self._write(200, {"ok": True, "kind": "copilot", **echo})
            return

        if path.endswith("/slow-generic"):
            delay = float(query.get("delay", ["65"])[0])
            threading.Event().wait(delay)
            self._write(200, {"ok": True, "kind": "generic-slow", **echo})
            return

        self._write(200, {"ok": True, "kind": "fast", **echo})


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 8000), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
