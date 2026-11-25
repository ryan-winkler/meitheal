#!/usr/bin/env python3
"""Create a deterministic local Marketplace repository tree from a Meitheal commit."""

import argparse
import json
import re
import shutil
import subprocess  # nosec B404
import tarfile
from hashlib import sha256
from io import BytesIO
from pathlib import Path, PurePosixPath
from zipfile import ZipFile, ZipInfo

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE = "integrations/home-assistant"
COMPONENT = "custom_components/meitheal"
REPOSITORY_FILES = ("LICENSE", "README.md", "hacs.json", ".github/workflows/validate.yaml")
REQUIRED_FILES = {
    *REPOSITORY_FILES,
    f"{COMPONENT}/__init__.py",
    f"{COMPONENT}/manifest.json",
    f"{COMPONENT}/services.yaml",
    f"{COMPONENT}/translations/en.json",
    f"{COMPONENT}/brand/icon.png",
}


def read_files(ref: str) -> dict[str, bytes]:
    git_bin = shutil.which("git")
    if git_bin is None:
        raise FileNotFoundError("git executable not found in PATH")
    commit = subprocess.check_output(  # nosec B603  # nosemgrep
        [git_bin, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"],  # nosemgrep
        cwd=REPO_ROOT,
        text=True,
    ).strip()
    archive = subprocess.check_output(  # nosec B603  # nosemgrep
        [git_bin, "archive", "--format=tar", f"{commit}:{SOURCE}", *REPOSITORY_FILES, COMPONENT],  # nosemgrep
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
            if entry.name not in REPOSITORY_FILES:
                if not entry.name.startswith(f"{COMPONENT}/"):
                    raise ValueError(f"Unexpected package entry: {entry.name}")
                if any(part.startswith(".") for part in path.parts):
                    continue
            stream = source.extractfile(entry)
            if stream is None:
                raise ValueError(f"Unable to read archive entry: {entry.name}")
            files[entry.name] = stream.read()

    missing = REQUIRED_FILES.difference(files)
    if missing:
        raise ValueError(f"Missing package files: {', '.join(sorted(missing))}")
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new ZIP file to write")
    parser.add_argument("--ref", default="HEAD", help="Git commit or ref to package")
    parser.add_argument("--repository", required=True, help="owner/name of the public integration repository")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}", args.repository):
        parser.error("--repository must be a GitHub owner/name")
    if args.repository.split("/")[1] in (".", ".."):
        parser.error("--repository must name a repository")

    try:
        files = read_files(args.ref)
        repository_url = f"https://github.com/{args.repository}"
        manifest_path = f"{COMPONENT}/manifest.json"
        manifest = json.loads(files[manifest_path])
        manifest["documentation"] = repository_url + "#readme"
        manifest["issue_tracker"] = repository_url + "/issues"
        files[manifest_path] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
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
