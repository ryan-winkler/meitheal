#!/usr/bin/env python3
"""Create a deterministic local Marketplace repository tree from a Meitheal commit."""

import argparse
from hashlib import sha256
from io import BytesIO
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
from zipfile import ZipFile, ZipInfo

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE = "integrations/home-assistant"
COMPONENT = "custom_components/meitheal"
ROOT_FILES = ("LICENSE", "README.md", "hacs.json")
REQUIRED_FILES = {
    *ROOT_FILES,
    f"{COMPONENT}/__init__.py",
    f"{COMPONENT}/manifest.json",
    f"{COMPONENT}/services.yaml",
    f"{COMPONENT}/translations/en.json",
    f"{COMPONENT}/brand/icon.png",
}


def read_files(ref: str) -> dict[str, bytes]:
    commit = subprocess.check_output(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"],
        cwd=REPO_ROOT,
        text=True,
    ).strip()
    archive = subprocess.check_output(
        ["git", "archive", "--format=tar", f"{commit}:{SOURCE}", *ROOT_FILES, COMPONENT],
        cwd=REPO_ROOT,
    )
    files = {}
    with tarfile.open(fileobj=BytesIO(archive), mode="r:") as source:
        for entry in source:
            if entry.isdir():
                continue
            path = PurePosixPath(entry.name)
            if not entry.isfile() or path.is_absolute() or ".." in path.parts:
                raise ValueError(f"Invalid package entry: {entry.name}")
            if any(part.startswith(".") for part in path.parts):
                continue
            if entry.name not in ROOT_FILES and not entry.name.startswith(f"{COMPONENT}/"):
                raise ValueError(f"Unexpected package entry: {entry.name}")
            stream = source.extractfile(entry)
            assert stream is not None
            files[entry.name] = stream.read()

    missing = REQUIRED_FILES.difference(files)
    if missing:
        raise ValueError(f"Missing package files: {', '.join(sorted(missing))}")
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new ZIP file to write")
    parser.add_argument("--ref", default="HEAD", help="Git commit or ref to package")
    args = parser.parse_args()

    try:
        files = read_files(args.ref)
        # The stored bytes, entry order and ZIP metadata are stable across runs.
        with ZipFile(args.output, mode="x") as archive:
            for name, contents in sorted(files.items()):
                entry = ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, contents)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")

    digest = sha256(args.output.read_bytes()).hexdigest()
    print(f"{digest}  {args.output}")


if __name__ == "__main__":
    main()
