"""Extract an explicit allow-list of files from a local StarCraft II CASC."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
from pathlib import Path


SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sc2", required=True, type=Path)
    parser.add_argument("--dll", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--file", action="append", default=[])
    return parser.parse_args()


def load_casc_inspector():
    source = Path(__file__).with_name("casc-inspect.py")
    spec = importlib.util.spec_from_file_location("coopagent_casc_inspect", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load the CoopAgent CASC inspector")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    args = parse_args()
    requests = []
    for value in args.file:
        source, separator, name = value.partition("=")
        if not separator or not source or not SAFE_NAME.fullmatch(name):
            raise ValueError(f"Invalid CASC extraction request: {value}")
        requests.append((source, name))

    args.output.mkdir(parents=True, exist_ok=True)
    inspector = load_casc_inspector()
    storage = inspector.CascStorage(args.dll, args.sc2)
    extracted = []
    try:
        for source, name in requests:
            destination = (args.output / name).resolve()
            destination.relative_to(args.output.resolve())
            size = storage.extract(source, destination)
            extracted.append({"source": source, "file": name, "bytes": size})
    finally:
        storage.close()

    print(json.dumps({"status": "extracted", "items": extracted}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
