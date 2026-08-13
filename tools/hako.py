#!/usr/bin/env python3
"""Component-owned operational entry point for hakoniwa-web3d-drone."""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import shutil
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_FILES = (
    "index.html",
    "src/public/drone_viewer.js",
    "src/drone_operational_visualization.js",
    "src/terrain_grid_geometry.mjs",
    "src/terrain_environment.js",
    "src/lod1_city_environment.js",
    "src/mjcf_building_geometry.mjs",
    "src/mjcf_building.js",
    "src/index.js",
    "thirdparty/three/build/three.module.js",
    "thirdparty/three/examples/jsm/loaders/GLTFLoader.js",
    "thirdparty/three/examples/jsm/controls/OrbitControls.js",
    "thirdparty/three/examples/jsm/utils/BufferGeometryUtils.js",
    "thirdparty/three/LICENSE",
    "config/viewer-config-legacy.json",
    "config/viewer-config-fleets.json",
    "config/drone_types-origin-01.json",
    "assets/models/origin-01.glb",
    "assets/models/propeller_origin_01.glb",
    "assets/models/origin-01-LICENSE.txt",
    "thirdparty/hakoniwa-pdu-javascript/src/PduManager.js",
    "thirdparty/hakoniwa-pdu-javascript/src/impl/WebSocketCommunicationService.js",
)

SMOKE_PATHS = (
    "/index.html",
    "/config/viewer-config-legacy.json",
    "/src/public/drone_viewer.js",
    "/src/drone_operational_visualization.js",
    "/src/terrain_grid_geometry.mjs",
    "/src/terrain_environment.js",
    "/src/lod1_city_environment.js",
    "/src/mjcf_building_geometry.mjs",
    "/src/mjcf_building.js",
    "/thirdparty/three/build/three.module.js",
    "/thirdparty/three/examples/jsm/loaders/GLTFLoader.js",
    "/thirdparty/three/examples/jsm/controls/OrbitControls.js",
    "/thirdparty/three/examples/jsm/utils/BufferGeometryUtils.js",
    "/config/viewer-config-terrain-fixture.json",
    "/config/drone_types-origin-01.json",
    "/assets/models/origin-01.glb",
    "/assets/models/propeller_origin_01.glb",
    "/assets/models/origin-01-LICENSE.txt",
    "/tests/fixtures/terrain-grid-3x3.json",
    "/tests/fixtures/terrain-grid-visual-3x3.json",
    "/tests/fixtures/buildings-visual.xml",
    "/thirdparty/hakoniwa-pdu-javascript/src/PduManager.js",
)


def _check_required_files() -> list[str]:
    return [path for path in REQUIRED_FILES if not (ROOT / path).is_file()]


def _validate_viewer_configs() -> list[str]:
    errors: list[str] = []
    for path in sorted((ROOT / "config").glob("viewer-config-*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{path.relative_to(ROOT)}: cannot load JSON: {exc}")
            continue

        if data.get("version") != "1.0":
            errors.append(f"{path.relative_to(ROOT)}: version must be 1.0")

        mode = data.get("stateInput", {}).get("mode")
        if mode not in {"legacy", "fleets"}:
            errors.append(f"{path.relative_to(ROOT)}: stateInput.mode must be legacy or fleets")

        for key_path in (("three", "sceneConfigPath"), ("pdu", "pduDefPath")):
            value = data
            for key in key_path:
                value = value.get(key) if isinstance(value, dict) else None
            if not isinstance(value, str) or not value:
                errors.append(f"{path.relative_to(ROOT)}: {'.'.join(key_path)} is required")
                continue
            if value.startswith(("http://", "https://", "/")):
                continue
            resolved = (path.parent / value).resolve()
            if not resolved.is_file():
                errors.append(
                    f"{path.relative_to(ROOT)}: {'.'.join(key_path)} target does not exist: {value}"
                )
    return errors


def doctor() -> int:
    errors: list[str] = []
    if sys.version_info < (3, 9):
        errors.append(f"Python 3.9 or later is required; found {sys.version.split()[0]}")

    errors.extend(f"missing required file: {path}" for path in _check_required_files())
    errors.extend(_validate_viewer_configs())

    print(f"repository: {ROOT}")
    print(f"python: {sys.executable} ({sys.version.split()[0]})")
    if errors:
        for message in errors:
            print(f"ERROR: {message}", file=sys.stderr)
        print("doctor: BLOCKED", file=sys.stderr)
        return 1

    print("doctor: READY")
    return 0


def test() -> int:
    command = [
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        str(ROOT / "tests"),
        "-p",
        "test_*.py",
        "-v",
    ]
    result = subprocess.run(command, cwd=ROOT, check=False)
    if result.returncode != 0:
        return result.returncode
    node = shutil.which("node")
    if node:
        return subprocess.run(
            [node, str(ROOT / "tools" / "test_terrain_geometry.mjs")],
            cwd=ROOT,
            check=False,
        ).returncode
    print("NOTE: Node.js not found; terrain geometry runtime test was skipped")
    return 0


class _StaticHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".glb": "model/gltf-binary",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


class _QuietHandler(_StaticHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return


def serve(bind: str, port: int) -> int:
    handler = functools.partial(_StaticHandler, directory=str(ROOT))
    try:
        server = http.server.ThreadingHTTPServer((bind, port), handler)
    except OSError as exc:
        print(f"ERROR: cannot listen on {bind}:{port}: {exc}", file=sys.stderr)
        return 1
    actual_port = server.server_address[1]
    print(f"serving {ROOT} at http://{bind}:{actual_port}/", flush=True)
    print("press Ctrl+C to stop", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


def smoke() -> int:
    missing = _check_required_files()
    if missing:
        for path in missing:
            print(f"ERROR: missing required file: {path}", file=sys.stderr)
        return 1

    handler = functools.partial(_QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    port = server.server_address[1]
    try:
        for path in SMOKE_PATHS:
            url = f"http://127.0.0.1:{port}{path}"
            with urllib.request.urlopen(url, timeout=5) as response:
                payload = response.read()
                if response.status != 200 or not payload:
                    raise RuntimeError(f"unexpected response for {path}: status={response.status}")
                if path.endswith(".mjs") and response.headers.get_content_type() != "text/javascript":
                    raise RuntimeError(
                        f"unexpected MIME type for {path}: "
                        f"{response.headers.get_content_type()}"
                    )
                if "no-store" not in response.headers.get("Cache-Control", ""):
                    raise RuntimeError(f"missing no-store cache policy for {path}")
            print(f"OK: {path}")
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: smoke failed: {exc}", file=sys.stderr)
        return 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    print("smoke: PASSED")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("doctor", "test", "smoke", "serve"))
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()

    if args.command == "serve":
        return serve(args.bind, args.port)

    return {
        "doctor": doctor,
        "test": test,
        "smoke": smoke,
    }[args.command]()


if __name__ == "__main__":
    raise SystemExit(main())
