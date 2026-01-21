#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


REPO_ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = REPO_ROOT / "data" / "index" / "entries-manifest.json"


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _safe_repo_path(path_text: str) -> Path:
    target = (REPO_ROOT / path_text).resolve()
    try:
        target.relative_to(REPO_ROOT.resolve())
    except ValueError as exc:
        raise ValueError("Invalid path") from exc
    return target


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 (stdlib)
        parsed = urlparse(self.path)
        if parsed.path in ("", "/"):
            self.send_response(302)
            self.send_header("Location", "/docs/?source=local")
            self.end_headers()
            return
        return super().do_GET()

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        raw = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802 (stdlib)
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") != "/save":
            self.send_error(404, "Not found")
            return

        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0:
            return self._send_json(400, {"ok": False, "error": "Missing request body"})
        if length > 50 * 1024 * 1024:
            return self._send_json(413, {"ok": False, "error": "Request too large"})

        body = self.rfile.read(length)
        try:
            req = json.loads(body)
        except Exception as e:  # noqa: BLE001
            return self._send_json(400, {"ok": False, "error": f"Invalid JSON: {e}"})
        if not isinstance(req, dict):
            return self._send_json(400, {"ok": False, "error": "Request JSON must be an object"})

        weeks = req.get("weeks")
        if not isinstance(weeks, list):
            return self._send_json(400, {"ok": False, "error": "'weeks' must be an array"})

        for item in weeks:
            if not isinstance(item, dict):
                continue
            path_text = str(item.get("path") or "")
            content = item.get("content")
            if not path_text.startswith("data/entries/") or not path_text.endswith(".json"):
                return self._send_json(400, {"ok": False, "error": f"Invalid week path: {path_text}"})
            if not isinstance(content, str):
                return self._send_json(400, {"ok": False, "error": f"Week {path_text}: 'content' must be a string"})

            out_path = _safe_repo_path(path_text)
            _write_text(out_path, content)

        manifest = req.get("manifest")
        if not isinstance(manifest, dict):
            return self._send_json(400, {"ok": False, "error": "'manifest' must be an object"})
        manifest_path = str(manifest.get("path") or "")
        manifest_content = manifest.get("content")
        if manifest_path != "data/index/entries-manifest.json":
            return self._send_json(400, {"ok": False, "error": "Invalid manifest path"})
        if not isinstance(manifest_content, str):
            return self._send_json(400, {"ok": False, "error": "'manifest.content' must be a string"})

        _write_text(MANIFEST_PATH, manifest_content)
        return self._send_json(200, {"ok": True})


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Local dev server for timetracking viewer/editor (serves repo root + POST /save).")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8000, help="Bind port. Default: 8000")
    args = parser.parse_args(argv)

    handler = lambda *a, **k: Handler(*a, directory=str(REPO_ROOT), **k)  # noqa: E731 (simple factory)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {REPO_ROOT} on http://{args.host}:{args.port} (open /docs/?source=local).")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv[1:]))
