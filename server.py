#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


APP_ROOT = Path(__file__).resolve().parent


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _normalize_workspace_path(path_text: str) -> str:
    normalized = path_text.strip()
    if not normalized or normalized.startswith("/") or normalized.endswith("/") or "\\" in normalized:
        raise ValueError("Invalid workspace path")
    parts = normalized.split("/")
    if any(not part or part in (".", "..") for part in parts):
        raise ValueError("Invalid workspace path")
    return "/".join(parts)


def _safe_workspace_path(workspace_root: Path, path_text: str) -> Path:
    normalized = _normalize_workspace_path(path_text)
    target = (workspace_root / normalized).resolve()
    try:
        target.relative_to(workspace_root.resolve())
    except ValueError as exc:
        raise ValueError("Invalid path") from exc
    return target


def _is_allowed_workspace_path(path_text: str, workspace_config_path: str) -> bool:
    try:
        normalized = _normalize_workspace_path(path_text)
    except ValueError:
        return False
    if normalized == workspace_config_path:
        return True
    return normalized.endswith(".json") and not any(part.startswith(".") for part in normalized.split("/"))


def _default_workspace_root() -> Path:
    if (APP_ROOT / "zeitplural.json").is_file():
        return APP_ROOT
    return APP_ROOT.parent / "zeitplural-data"


def _is_application_route(path: str, app_entry_path: str) -> bool:
    base = app_entry_path.rstrip("/")
    if base and base != "/":
        if path == base:
            return False
        prefix = f"{base}/"
        if not path.startswith(prefix):
            return False
        relative = path.removeprefix(prefix)
    else:
        relative = path.lstrip("/")
    return relative.rstrip("/") in {"time", "todos", "expenses"}


class Handler(SimpleHTTPRequestHandler):
    workspace_root = APP_ROOT
    workspace_config_path = "zeitplural.json"
    app_entry_path = "/docs/"

    def do_GET(self) -> None:  # noqa: N802 (stdlib)
        parsed = urlparse(self.path)
        if parsed.path in ("", "/"):
            if self.app_entry_path == "/" and parse_qs(parsed.query).get("source") == ["local"]:
                return super().do_GET()
            self.send_response(302)
            self.send_header("Location", f"{self.app_entry_path}?source=local")
            self.end_headers()
            return
        if parsed.path == "/workspace-config" or parsed.path.startswith("/workspace/"):
            path_text = (
                self.workspace_config_path
                if parsed.path == "/workspace-config"
                else unquote(parsed.path.removeprefix("/workspace/"))
            )
            if not _is_allowed_workspace_path(path_text, self.workspace_config_path):
                self.send_error(404, "Not found")
                return
            try:
                target = _safe_workspace_path(self.workspace_root, path_text)
                raw = target.read_bytes()
            except (OSError, ValueError):
                self.send_error(404, "Not found")
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if _is_application_route(parsed.path, self.app_entry_path):
            original_path = self.path
            try:
                self.path = f"{self.app_entry_path.rstrip('/')}/index.html"
                return super().do_GET()
            finally:
                self.path = original_path
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

        files = req.get("files")
        if not isinstance(files, list):
            weeks = req.get("weeks")
            manifest = req.get("manifest")
            if isinstance(weeks, list) and isinstance(manifest, dict):
                files = weeks + [manifest]
            else:
                return self._send_json(400, {"ok": False, "error": "'files' must be an array"})

        for item in files:
            if not isinstance(item, dict):
                continue
            path_text = str(item.get("path") or "")
            content = item.get("content")
            if not _is_allowed_workspace_path(path_text, self.workspace_config_path):
                return self._send_json(400, {"ok": False, "error": f"Invalid path: {path_text}"})
            if not isinstance(content, str):
                return self._send_json(400, {"ok": False, "error": f"{path_text}: 'content' must be a string"})

            out_path = _safe_workspace_path(self.workspace_root, path_text)
            _write_text(out_path, content)
        return self._send_json(200, {"ok": True})


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Local zeitplural development server with a separately selectable data workspace.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8000, help="Bind port. Default: 8000")
    parser.add_argument(
        "--workspace",
        type=Path,
        default=_default_workspace_root(),
        help="Workspace repository root. Defaults to this mixed checkout or the sibling ../zeitplural-data repository.",
    )
    parser.add_argument(
        "--workspace-config",
        default="zeitplural.json",
        help="Workspace config path relative to --workspace. Default: zeitplural.json",
    )
    args = parser.parse_args(argv)

    workspace_root = args.workspace.expanduser().resolve()
    workspace_config_path = _normalize_workspace_path(args.workspace_config)
    app_entry_path = "/" if (APP_ROOT / "index.html").is_file() else "/docs/"

    class ConfiguredHandler(Handler):
        pass

    ConfiguredHandler.workspace_root = workspace_root
    ConfiguredHandler.workspace_config_path = workspace_config_path
    ConfiguredHandler.app_entry_path = app_entry_path

    handler = lambda *a, **k: ConfiguredHandler(*a, directory=str(APP_ROOT), **k)  # noqa: E731 (simple factory)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving zeitplural from {APP_ROOT} on http://{args.host}:{args.port}{app_entry_path}time?source=local")
    print(f"Workspace: {workspace_root} ({workspace_config_path})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv[1:]))
