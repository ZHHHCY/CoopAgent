#!/usr/bin/env python3
"""Create a read-only StarCraft II CASC index and a small co-op data extract."""

from __future__ import annotations

import argparse
import ctypes
import gzip
import json
import os
import re
import shutil
import sys
from collections import Counter
from ctypes import c_bool, c_char, c_char_p, c_int, c_size_t, c_ubyte
from ctypes import c_uint32, c_uint64, c_void_p
from pathlib import Path, PureWindowsPath


MAX_PATH = 260
INVALID_HANDLE_VALUE = c_void_p(-1).value
READ_CHUNK_SIZE = 4 * 1024 * 1024
CASC_EXTRACTOR_VERSION = 2

BASE_DEPENDENCIES = {
    "core.sc2mod",
    "liberty.sc2mod",
    "libertymulti.sc2mod",
    "swarm.sc2mod",
    "swarmmulti.sc2mod",
    "void.sc2mod",
    "voidmulti.sc2mod",
}

# Allied Commanders inherits campaign Catalog layers as well as the expansion
# Mods. These packages contain gameplay definitions that StarCoop reuses
# directly (for example BarracksTrain Train5/Train6 -> Medic/Firebat).
CAMPAIGN_DEPENDENCIES = {
    "libertystory.sc2campaign",
    "liberty.sc2campaign",
    "swarmstoryutil.sc2mod",
    "swarmstory.sc2campaign",
    "swarm.sc2campaign",
    "voidstory.sc2campaign",
    "void.sc2campaign",
}

ROOT_METADATA = {
    "componentlist.sc2components",
    "documentheader",
    "documentinfo",
    "documentinfo.version",
    "gamedata.version",
    "gametext.version",
    "preload.xml",
}


class CascFindData(ctypes.Structure):
    _fields_ = [
        ("szFileName", c_char * MAX_PATH),
        ("CKey", c_ubyte * 16),
        ("EKey", c_ubyte * 16),
        ("TagBitMask", c_uint64),
        ("FileSize", c_uint64),
        ("szPlainName", c_void_p),
        ("dwFileDataId", c_uint32),
        ("dwLocaleFlags", c_uint32),
        ("dwContentFlags", c_uint32),
        ("dwSpanCount", c_uint32),
        ("bFileAvailable", c_uint32, 1),
        ("NameType", c_int),
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sc2", required=True, type=Path)
    parser.add_argument("--dll", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def read_build_version(sc2_root: Path) -> str:
    build_info = sc2_root / ".build.info"
    lines = build_info.read_text(encoding="utf-8-sig").splitlines()
    if len(lines) < 2:
        return "unknown"
    headers = lines[0].split("|")
    values = lines[1].split("|")
    for index, header in enumerate(headers):
        if header.startswith("Version!") and index < len(values):
            return values[index] or "unknown"
    return "unknown"


def default_output(version: str) -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("系统未设置 LOCALAPPDATA")
    build_match = re.search(r"(\d+)$", version)
    build_name = f"B{build_match.group(1)}" if build_match else version
    return Path(local_app_data) / "CoopAgent" / "casc" / build_name


def extraction_is_complete(output_root: Path, sc2_root: Path, version: str) -> bool:
    manifest_path = output_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        source = manifest["source"]
        extract = manifest["extract"]
        return (
            manifest["extractorVersion"] == CASC_EXTRACTOR_VERSION
            and Path(source["starCraftRoot"]).resolve() == sc2_root.resolve()
            and source["version"] == version
            and not extract["failures"]
            and extract["selectedFiles"] == extract["extractedFiles"]
            and (output_root / "files").is_dir()
            and (output_root / "known-files.tsv.gz").is_file()
            and (output_root / "selected-files.tsv").is_file()
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def recover_extraction_output(output_root: Path) -> None:
    backup = output_root.with_name(f"{output_root.name}.previous")
    if output_root.exists() and backup.exists():
        shutil.rmtree(backup)
    elif not output_root.exists() and backup.exists():
        backup.rename(output_root)
    for staging in output_root.parent.glob(f"{output_root.name}.building-*"):
        if staging.is_dir():
            shutil.rmtree(staging)


def publish_extraction(staging: Path, output_root: Path) -> None:
    backup = output_root.with_name(f"{output_root.name}.previous")
    if backup.exists():
        shutil.rmtree(backup)
    if output_root.exists():
        output_root.rename(backup)
    try:
        staging.rename(output_root)
    except BaseException:
        if not output_root.exists() and backup.exists():
            backup.rename(output_root)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def encode_windows_path(path: Path) -> bytes:
    return str(path.resolve()).encode("mbcs")


def decode_casc_name(raw: bytes) -> str:
    return raw.split(b"\0", 1)[0].decode("utf-8", errors="replace").replace("/", "\\")


def should_extract(path: str) -> str | None:
    parts = path.lower().split("\\")
    if len(parts) < 3:
        return None

    if parts[0] == "campaigns" and parts[1] in CAMPAIGN_DEPENDENCIES:
        package = parts[1]
        rest = "\\".join(parts[2:])
        return package if keep_package_file(rest) else None

    if parts[0] != "mods":
        return None

    package = parts[1]
    if package in BASE_DEPENDENCIES:
        rest = "\\".join(parts[2:])
        return package if keep_package_file(rest) else None

    if package == "alliedcommanders.sc2mod":
        rest = "\\".join(parts[2:])
        return package if keep_package_file(rest) else None

    if package == "starcoop" and len(parts) >= 5 and parts[2] == "commanders":
        commander_package = parts[3]
        rest = "\\".join(parts[4:])
        package_id = f"starcoop/commanders/{commander_package}"
        return package_id if keep_package_file(rest) else None

    if package == "starcoop" and len(parts) >= 4:
        rest = "\\".join(parts[3:])
        return "starcoop" if keep_package_file(rest) else None

    return None


def keep_package_file(rest: str) -> bool:
    if rest.startswith("base.sc2data\\gamedata\\"):
        return True
    if rest.startswith("base.sc2data\\triggerlibs\\"):
        return True
    if rest.startswith("base.sc2data\\") and rest.endswith((".galaxy", ".xml")):
        return True
    if rest.startswith("zhcn.sc2data\\localizeddata\\"):
        return True
    if rest.startswith("enus.sc2data\\localizeddata\\"):
        return True
    return rest in ROOT_METADATA


def safe_output_path(root: Path, casc_path: str) -> Path:
    pure = PureWindowsPath(casc_path)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ValueError(f"不安全的 CASC 路径：{casc_path}")
    destination = root.joinpath(*pure.parts)
    destination.resolve().relative_to(root.resolve())
    return destination


class CascStorage:
    def __init__(self, dll_path: Path, sc2_root: Path) -> None:
        self.dll = ctypes.WinDLL(str(dll_path.resolve()), use_last_error=True)
        self._bind()
        self.handle = c_void_p()
        if not self.dll.CascOpenStorage(encode_windows_path(sc2_root), 0, ctypes.byref(self.handle)):
            raise OSError(self.error, f"CascOpenStorage failed for {sc2_root}")

    @property
    def error(self) -> int:
        return int(self.dll.GetCascError())

    def _bind(self) -> None:
        self.dll.CascOpenStorage.argtypes = [c_char_p, c_uint32, ctypes.POINTER(c_void_p)]
        self.dll.CascOpenStorage.restype = c_bool
        self.dll.CascCloseStorage.argtypes = [c_void_p]
        self.dll.CascCloseStorage.restype = c_bool
        self.dll.CascFindFirstFile.argtypes = [c_void_p, c_char_p, ctypes.POINTER(CascFindData), c_char_p]
        self.dll.CascFindFirstFile.restype = c_void_p
        self.dll.CascFindNextFile.argtypes = [c_void_p, ctypes.POINTER(CascFindData)]
        self.dll.CascFindNextFile.restype = c_bool
        self.dll.CascFindClose.argtypes = [c_void_p]
        self.dll.CascFindClose.restype = c_bool
        self.dll.CascOpenFile.argtypes = [c_void_p, c_void_p, c_uint32, c_uint32, ctypes.POINTER(c_void_p)]
        self.dll.CascOpenFile.restype = c_bool
        self.dll.CascGetFileSize64.argtypes = [c_void_p, ctypes.POINTER(c_uint64)]
        self.dll.CascGetFileSize64.restype = c_bool
        self.dll.CascReadFile.argtypes = [c_void_p, c_void_p, c_uint32, ctypes.POINTER(c_uint32)]
        self.dll.CascReadFile.restype = c_bool
        self.dll.CascCloseFile.argtypes = [c_void_p]
        self.dll.CascCloseFile.restype = c_bool
        self.dll.GetCascError.restype = c_uint32

    def files(self):
        data = CascFindData()
        find_handle = self.dll.CascFindFirstFile(self.handle, b"*", ctypes.byref(data), None)
        if not find_handle or find_handle == INVALID_HANDLE_VALUE:
            raise OSError(self.error, "CascFindFirstFile failed")
        try:
            while True:
                yield data
                if not self.dll.CascFindNextFile(find_handle, ctypes.byref(data)):
                    break
        finally:
            self.dll.CascFindClose(find_handle)

    def extract(self, casc_path: str, destination: Path) -> int:
        encoded_name = casc_path.encode("utf-8")
        name_buffer = ctypes.create_string_buffer(encoded_name)
        file_handle = c_void_p()
        if not self.dll.CascOpenFile(
            self.handle,
            ctypes.cast(name_buffer, c_void_p),
            0,
            0,
            ctypes.byref(file_handle),
        ):
            raise OSError(self.error, f"CascOpenFile failed: {casc_path}")
        try:
            size = c_uint64()
            if not self.dll.CascGetFileSize64(file_handle, ctypes.byref(size)):
                raise OSError(self.error, f"CascGetFileSize64 failed: {casc_path}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            remaining = size.value
            buffer = ctypes.create_string_buffer(min(READ_CHUNK_SIZE, max(remaining, 1)))
            with destination.open("wb") as output:
                while remaining:
                    requested = min(len(buffer), remaining)
                    read = c_uint32()
                    if not self.dll.CascReadFile(file_handle, buffer, requested, ctypes.byref(read)):
                        raise OSError(self.error, f"CascReadFile failed: {casc_path}")
                    if not read.value:
                        raise OSError(f"Unexpected end of CASC file: {casc_path}")
                    output.write(buffer.raw[: read.value])
                    remaining -= read.value
            return size.value
        finally:
            self.dll.CascCloseFile(file_handle)

    def close(self) -> None:
        if self.handle:
            self.dll.CascCloseStorage(self.handle)
            self.handle = c_void_p()


def format_size(size: int) -> str:
    return f"{size / (1024 * 1024):.1f} MiB"


def main() -> int:
    args = parse_args()
    version = read_build_version(args.sc2)
    final_output_root = (args.output or default_output(version)).resolve()
    final_output_root.parent.mkdir(parents=True, exist_ok=True)
    recover_extraction_output(final_output_root)
    if extraction_is_complete(final_output_root, args.sc2, version):
        print(f"复用已有 CASC 提取结果：{final_output_root}")
        print(f"CASC_OUTPUT={final_output_root}")
        return 0

    output_root = final_output_root.with_name(
        f"{final_output_root.name}.building-{os.getpid()}"
    )
    if output_root.exists():
        shutil.rmtree(output_root)
    files_root = output_root / "files"
    output_root.mkdir(parents=True, exist_ok=True)

    known_count = 0
    local_known_count = 0
    selected = []
    top_levels: Counter[str] = Counter()
    mod_packages: Counter[str] = Counter()
    package_counts: Counter[str] = Counter()
    package_sizes: Counter[str] = Counter()

    index_path = output_root / "known-files.tsv.gz"
    storage = CascStorage(args.dll, args.sc2)
    try:
        with gzip.open(index_path, "wt", encoding="utf-8", newline="\n") as index:
            index.write("path\tsize\tavailable\tname_type\tckey\n")
            for item in storage.files():
                path = decode_casc_name(bytes(item.szFileName))
                ckey = bytes(item.CKey).hex()
                index.write(f"{path}\t{item.FileSize}\t{item.bFileAvailable}\t{item.NameType}\t{ckey}\n")
                if item.NameType != 0:
                    continue
                known_count += 1
                if item.bFileAvailable:
                    local_known_count += 1
                parts = path.lower().split("\\")
                if parts:
                    top_levels[parts[0]] += 1
                if len(parts) >= 2 and parts[0] == "mods":
                    mod_packages[parts[1]] += 1
                package = should_extract(path)
                if package and item.bFileAvailable:
                    selected.append(
                        {
                            "path": path,
                            "size": int(item.FileSize),
                            "ckey": ckey,
                            "package": package,
                        }
                    )

        failures = []
        extracted_bytes = 0
        for number, item in enumerate(selected, start=1):
            destination = safe_output_path(files_root, item["path"])
            try:
                extracted_bytes += storage.extract(item["path"], destination)
                package_counts[item["package"]] += 1
                package_sizes[item["package"]] += item["size"]
            except OSError as error:
                failures.append({"path": item["path"], "error": str(error)})
            if number % 100 == 0 or number == len(selected):
                print(f"已提取 {number}/{len(selected)} 个文件…", flush=True)
    finally:
        storage.close()

    selected_index = output_root / "selected-files.tsv"
    with selected_index.open("w", encoding="utf-8", newline="\n") as file:
        file.write("package\tsize\tckey\tpath\n")
        for item in selected:
            file.write(f"{item['package']}\t{item['size']}\t{item['ckey']}\t{item['path']}\n")

    manifest = {
        "schemaVersion": 1,
        "extractorVersion": CASC_EXTRACTOR_VERSION,
        "source": {
            "starCraftRoot": str(args.sc2.resolve()),
            "version": version,
            "cascLibrary": str(args.dll.resolve()),
        },
        "index": {
            "knownNames": known_count,
            "availableKnownNames": local_known_count,
            "compressedFileIndex": str(final_output_root / index_path.name),
            "topLevels": dict(top_levels.most_common()),
            "modPackages": dict(sorted(mod_packages.items())),
        },
        "extract": {
            "root": str(final_output_root / "files"),
            "selectedFiles": len(selected),
            "extractedFiles": sum(package_counts.values()),
            "extractedBytes": extracted_bytes,
            "packages": {
                name: {"files": package_counts[name], "bytes": package_sizes[name]}
                for name in sorted(package_counts)
            },
            "failures": failures,
        },
    }
    (output_root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    structure_lines = [
        "CoopAgent - StarCraft II CASC inspection",
        "",
        f"Game version: {version}",
        f"Known logical paths: {known_count}",
        f"Known paths available locally: {local_known_count}",
        f"Selected co-op/catalog files: {len(selected)}",
        f"Extracted: {sum(package_counts.values())} files, {format_size(extracted_bytes)}",
        "",
        "CASC logical top level:",
    ]
    structure_lines.extend(f"  {name}: {count}" for name, count in top_levels.most_common())
    structure_lines.extend(["", "Extracted dependency packages (catalog/script/text only):"])
    structure_lines.extend(
        f"  {name}: {package_counts[name]} files, {format_size(package_sizes[name])}"
        for name in sorted(package_counts)
    )
    structure_lines.extend(
        [
            "",
            "Important paths:",
            "  files\\mods\\starcoop\\starcoop.sc2mod\\base.sc2data\\gamedata",
            "    Main cooperative Catalog XML files (Unit, Ability, Effect, Behavior, etc.).",
            "  files\\mods\\starcoop\\starcoop.sc2mod\\base.sc2data\\*.galaxy",
            "    Cooperative Galaxy libraries and runtime logic.",
            "  files\\mods\\starcoop\\starcoop.sc2mod\\zhcn.sc2data\\localizeddata",
            "    Simplified Chinese localized strings.",
            "  files\\mods\\starcoop\\commanders",
            "    Commander-specific packages stored separately from StarCoop.",
            "  files\\mods\\{core,liberty,swarm,void}*.sc2mod\\base.sc2data\\gamedata",
            "    Lower dependency layers inherited by cooperative data.",
            "  files\\campaigns\\{liberty,swarm,void}*.sc2campaign\\base.sc2data\\gamedata",
            "    Campaign Catalog layers reused by Allied Commanders.",
            "",
            "The full logical file listing is in known-files.tsv.gz.",
            "The extracted file manifest is in selected-files.tsv and manifest.json.",
        ]
    )
    (output_root / "CASC-STRUCTURE.txt").write_text("\n".join(structure_lines) + "\n", encoding="utf-8")

    if failures:
        print(f"提取完成，其中 {len(failures)} 个文件失败。", file=sys.stderr)
        shutil.rmtree(output_root)
        return 2
    publish_extraction(output_root, final_output_root)
    print(f"CASC_OUTPUT={final_output_root}")
    print(f"提取完成：{sum(package_counts.values())} 个文件，{format_size(extracted_bytes)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
