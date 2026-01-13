#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo


REPO_ROOT = Path(__file__).resolve().parent
ENTRIES_DIR = REPO_ROOT / "data" / "entries"
MANIFEST_PATH = REPO_ROOT / "data" / "index" / "entries-manifest.json"


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _git_blob_sha1(content: bytes) -> str:
    header = f"blob {len(content)}\0".encode("utf-8")
    return hashlib.sha1(header + content).hexdigest()  # noqa: S324 (git compatibility)


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _load_entry_count(path: Path) -> int | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(payload, dict):
        return None
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return None
    return len(entries)


def _build_manifest(*, tz: ZoneInfo) -> dict[str, Any]:
    chunks: list[dict[str, Any]] = []
    total_entries = 0

    if ENTRIES_DIR.exists():
        for year_dir in sorted(ENTRIES_DIR.iterdir()):
            if not year_dir.is_dir():
                continue
            if not year_dir.name.isdigit() or len(year_dir.name) != 4:
                continue
            year = int(year_dir.name)

            for week_file in sorted(year_dir.glob("*.json")):
                try:
                    week = int(week_file.stem)
                except ValueError:
                    continue
                if week < 1 or week > 53:
                    continue

                content_bytes = week_file.read_bytes()
                sha = _git_blob_sha1(content_bytes)
                size = len(content_bytes)
                entry_count = _load_entry_count(week_file)
                if isinstance(entry_count, int):
                    total_entries += entry_count

                chunks.append(
                    {
                        "entries": entry_count,
                        "path": week_file.relative_to(REPO_ROOT).as_posix(),
                        "sha": sha,
                        "size": size,
                        "week": week,
                        "year": year,
                    }
                )

    chunks.sort(key=lambda c: (c["year"], c["week"]))
    return {
        "chunks": chunks,
        "generated_at": _utc_now_iso(),
        "schema_version": 1,
        "timezone": tz.key,
        "total_chunks": len(chunks),
        "total_entries": total_entries,
    }


def _week_file_path(year: int, week: int) -> Path:
    return ENTRIES_DIR / f"{year}" / f"{week:02}.json"


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

        tz_raw = req.get("timezone")
        try:
            tz = ZoneInfo(str(tz_raw or "Europe/Berlin"))
        except Exception:  # noqa: BLE001
            tz = ZoneInfo("Europe/Berlin")

        weeks = req.get("weeks")
        if not isinstance(weeks, list):
            return self._send_json(400, {"ok": False, "error": "'weeks' must be an array"})

        saved: list[dict[str, Any]] = []
        for item in weeks:
            if not isinstance(item, dict):
                continue
            year = item.get("year")
            week = item.get("week")
            entries = item.get("entries")
            if not isinstance(year, int) or year < 1970 or year > 9999:
                return self._send_json(400, {"ok": False, "error": f"Invalid year: {year}"})
            if not isinstance(week, int) or week < 1 or week > 53:
                return self._send_json(400, {"ok": False, "error": f"Invalid week: {week}"})
            if not isinstance(entries, list):
                return self._send_json(400, {"ok": False, "error": f"Week {year}-W{week:02}: 'entries' must be an array"})

            entries_dicts = [e for e in entries if isinstance(e, dict)]
            entries_sorted = sorted(entries_dicts, key=lambda e: (str(e.get("start", "")), int(e.get("id") or 0)))

            payload = {
                "entries": entries_sorted,
                "generated_at": _utc_now_iso(),
                "schema_version": 1,
                "timezone": tz.key,
                "week": week,
                "year": year,
            }
            content = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
            out_path = _week_file_path(year, week)
            _write_text(out_path, content)

            content_bytes = content.encode("utf-8")
            saved.append(
                {
                    "entries": len(entries_sorted),
                    "path": out_path.relative_to(REPO_ROOT).as_posix(),
                    "sha": _git_blob_sha1(content_bytes),
                    "size": len(content_bytes),
                    "week": week,
                    "year": year,
                }
            )

        manifest = _build_manifest(tz=tz)
        _write_text(MANIFEST_PATH, json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        return self._send_json(200, {"ok": True, "manifest": manifest, "saved": saved})


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
