#!/usr/bin/env python3
"""Keep VERSION, bridge.py, both manifests and README on one version."""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = {
    "bridge": (ROOT / "bridge.py", re.compile(r'BRIDGE_VERSION = "[^"]+"')),
    "manifest": (ROOT / "snapgent-extension" / "manifest.json", None),
    "readme": (ROOT / "README.md", re.compile(r"V\d+\.\d+\.\d+")),
}


VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


def checked_version(raw: str) -> str:
    """Accept only strict semver so file content cannot steer a write."""
    version = raw.strip()
    if not VERSION_RE.fullmatch(version):
        raise SystemExit(f"invalid version: {raw!r}")
    return version


def current() -> str:
    return checked_version((ROOT / "VERSION").read_text(encoding="utf-8"))


def values() -> dict[str, str]:
    version = current()
    out = {"version": version}
    for name, (path, pattern) in FILES.items():
        if not path.exists():
            out[name] = "MISSING"
            continue
        text = path.read_text(encoding="utf-8")
        if name.endswith("manifest"):
            out[name] = json.loads(text).get("version", "")
        else:
            match = pattern.search(text)
            out[name] = match.group(0) if match else ""
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify only")
    parser.add_argument("--set", metavar="VERSION", help="write this version everywhere")
    args = parser.parse_args()

    if args.set:
        version = checked_version(args.set)
        (ROOT / "VERSION").write_text(version + "\n", encoding="utf-8")
        for name, (path, pattern) in FILES.items():
            if not path.exists():
                continue
            text = path.read_text(encoding="utf-8")
            if name.endswith("manifest"):
                data = json.loads(text)
                data["version"] = version
                text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
            elif pattern:
                replacement = (f'BRIDGE_VERSION = "{version}"' if name == "bridge"
                               else f"V{version}")
                text = pattern.sub(replacement, text)
            path.write_text(text, encoding="utf-8")

    found = values()
    def normalize(v: str) -> str:
        return (v.replace('BRIDGE_VERSION = "', "").replace('"', "")
                 .replace("V", "").strip())

    ok = all(normalize(v) == normalize(found["version"])
             for k, v in found.items() if k != "version")
    for key, value in found.items():
        print(f"{key:14s} {value}")
    if not ok:
        print("VERSION MISMATCH", file=sys.stderr)
        return 1
    print("version sync OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
