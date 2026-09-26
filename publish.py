#!/usr/bin/env python3
"""Publish Obsidian notes to the Astro blog and upload local images to R2.

Obsidian remains the canonical authoring source. Published Markdown is generated
under ``src/content/blog``; local image references are replaced with immutable,
content-addressed URLs on img.ljy.app.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import boto3
import yaml
from botocore.exceptions import ClientError
from dotenv import load_dotenv

BLOG_ROOT = Path(__file__).resolve().parent
load_dotenv(BLOG_ROOT / ".env")

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME")
R2_PUBLIC_URL = (os.getenv("R2_PUBLIC_URL") or "https://img.ljy.app").rstrip("/")
DEFAULT_VAULT = os.getenv("OBSIDIAN_VAULT")
NODE_BIN = os.getenv("BLOG_NODE_BIN")
DEFAULT_OUTPUT_DIR = BLOG_ROOT / "src/content/blog"
DEFAULT_BRANCH = os.getenv("BLOG_PUBLISH_BRANCH") or "v5"
ASSET_PREFIX = "blog-assets"
PROTOCOL_VERSION = 1
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg"}
REMOTE_PREFIXES = ("https://", "http://", "data:", "//")
WIKI_EMBED = re.compile(r"!\[\[([^\]]+)\]\]")
HTML_TAG = re.compile(r"<img\b[^>]*>", re.IGNORECASE | re.DOTALL)
HTML_SRC = re.compile(r"\bsrc\s*=\s*(?P<quote>[\"'])(?P<src>.*?)(?P=quote)", re.IGNORECASE | re.DOTALL)
REFERENCE_IMAGE = re.compile(r"!\[(?!\[)[^\]\n]*\]\s*\[[^\]\n]*\]")
FRONTMATTER_END = re.compile(r"^---\s*$", re.MULTILINE)


class PublishError(RuntimeError):
    def __init__(self, message: str, code: str = "PUBLISH_ERROR") -> None:
        super().__init__(message)
        self.code = code


class Reporter:
    def __init__(self, json_mode: bool = False) -> None:
        self.json_mode = json_mode

    def log(self, message: str) -> None:
        print(message, file=sys.stderr if self.json_mode else sys.stdout)


@dataclass(frozen=True)
class Frontmatter:
    data: dict[str, Any]
    raw: str
    body: str


@dataclass
class ImageReference:
    kind: str
    start: int
    end: int
    raw_path: str
    alt: str = ""
    local_path: Path | None = None
    sha256: str | None = None
    object_key: str | None = None
    public_url: str | None = None


@dataclass
class PostPlan:
    source: Path
    output: Path
    permalink: str
    published: bool
    source_content: str
    rendered_content: str
    references: list[ImageReference] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def local_assets(self) -> list[ImageReference]:
        return [reference for reference in self.references if reference.local_path]

    def as_dict(self) -> dict[str, Any]:
        unique_assets = {reference.object_key for reference in self.local_assets}
        return {
            "source": str(self.source),
            "output": str(self.output),
            "permalink": self.permalink,
            "published": self.published,
            "disposition": "generate" if self.published else "remove",
            "references": len(self.references),
            "localAssets": len(unique_assets),
            "warnings": self.warnings,
            "assets": [
                {
                    "source": reference.raw_path,
                    "file": str(reference.local_path),
                    "sha256": reference.sha256,
                    "key": reference.object_key,
                    "url": reference.public_url,
                }
                for reference in self.local_assets
            ],
        }


def parse_frontmatter(content: str, source: Path) -> Frontmatter:
    if not content.startswith("---"):
        raise PublishError(f"Missing YAML frontmatter: {source}", "INVALID_FRONTMATTER")

    first_line_end = content.find("\n")
    if first_line_end < 0 or content[:first_line_end].strip() != "---":
        raise PublishError(f"Invalid YAML frontmatter opening: {source}", "INVALID_FRONTMATTER")

    match = FRONTMATTER_END.search(content, first_line_end + 1)
    if not match:
        raise PublishError(f"Missing YAML frontmatter closing fence: {source}", "INVALID_FRONTMATTER")

    raw = content[first_line_end + 1 : match.start()]
    body_start = match.end()
    if body_start < len(content) and content[body_start] == "\n":
        body_start += 1

    try:
        parsed = yaml.safe_load(raw) or {}
    except yaml.YAMLError as error:
        raise PublishError(f"Invalid YAML in {source}: {error}", "INVALID_FRONTMATTER") from error
    if not isinstance(parsed, dict):
        raise PublishError(f"Frontmatter must be a mapping: {source}", "INVALID_FRONTMATTER")
    return Frontmatter(parsed, raw, content[body_start:])


def validate_permalink(value: Any, source: Path) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PublishError(
            f"Frontmatter 'permalink' is required: {source}",
            "INVALID_PERMALINK",
        )
    permalink = value.strip()
    if permalink != value or len(permalink) > 160:
        raise PublishError(f"Invalid permalink: {value!r}", "INVALID_PERMALINK")
    if permalink != permalink.lower():
        raise PublishError(f"Permalink must be lowercase: {permalink}", "INVALID_PERMALINK")
    if permalink in {".", ".."} or any(char in permalink for char in "/\\?#%"):
        raise PublishError(f"Permalink must be one URL-safe path segment: {permalink}", "INVALID_PERMALINK")
    if any(char.isspace() or ord(char) < 32 for char in permalink):
        raise PublishError(f"Permalink cannot contain whitespace/control characters: {permalink}", "INVALID_PERMALINK")
    if any(not (char.isalnum() or char in "-._~") for char in permalink):
        raise PublishError(f"Unsupported character in permalink: {permalink}", "INVALID_PERMALINK")
    return permalink


def validate_metadata(frontmatter: Frontmatter, source: Path) -> tuple[str, bool, list[str]]:
    data = frontmatter.data
    title = data.get("title")
    if not isinstance(title, str) or not title.strip():
        raise PublishError(f"Frontmatter 'title' is required: {source}", "INVALID_METADATA")

    permalink = validate_permalink(data.get("permalink"), source)
    published = data.get("published", False)
    if not isinstance(published, bool):
        raise PublishError(f"Frontmatter 'published' must be true or false: {source}", "INVALID_METADATA")

    tags = data.get("tags", [])
    if tags is None:
        tags = []
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise PublishError(f"Frontmatter 'tags' must be a list of strings: {source}", "INVALID_METADATA")

    for key in ("description", "status", "author", "image"):
        value = data.get(key)
        if value is not None and not isinstance(value, str):
            raise PublishError(f"Frontmatter '{key}' must be a string: {source}", "INVALID_METADATA")

    warnings: list[str] = []
    if "published" not in data:
        warnings.append("'published' is missing; the post defaults to private")
    return permalink, published, warnings


def is_remote(path: str) -> bool:
    return path.lower().startswith(REMOTE_PREFIXES)


def decode_reference(raw_path: str) -> str:
    path = raw_path.strip()
    if path.startswith("<") and path.endswith(">"):
        path = path[1:-1]
    path = urllib.parse.unquote(path)
    path = re.sub(r"\\([ !\"#$%&'()*+,./:;<=>?@\[\]^_`{|}~-])", r"\1", path)
    return path.replace("\\", "/")


def protected_ranges(content: str) -> list[tuple[int, int]]:
    """Return fenced-code, inline-code, and HTML-comment ranges."""
    ranges: list[tuple[int, int]] = [
        (match.start(), match.end())
        for match in re.finditer(r"<!--.*?-->", content, re.DOTALL)
    ]
    lines = content.splitlines(keepends=True)
    offset = 0
    fence_start: int | None = None
    fence_char = ""
    fence_length = 0
    fence_pattern = re.compile(r"^ {0,3}(`{3,}|~{3,})")
    for line in lines:
        match = fence_pattern.match(line)
        if match:
            marker = match.group(1)
            if fence_start is None:
                fence_start = offset
                fence_char = marker[0]
                fence_length = len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_length:
                ranges.append((fence_start, offset + len(line)))
                fence_start = None
        elif fence_start is None:
            for inline in re.finditer(r"(`+)(.+?)\1", line):
                ranges.append((offset + inline.start(), offset + inline.end()))
        offset += len(line)
    if fence_start is not None:
        ranges.append((fence_start, len(content)))
    return sorted(ranges)


def overlaps_ranges(start: int, end: int, ranges: Sequence[tuple[int, int]]) -> bool:
    return any(start < protected_end and end > protected_start for protected_start, protected_end in ranges)


def find_unescaped(content: str, char: str, start: int) -> int:
    escaped = False
    for index in range(start, len(content)):
        current = content[index]
        if escaped:
            escaped = False
        elif current == "\\":
            escaped = True
        elif current == char:
            return index
    return -1


def scan_markdown_images(content: str, protected: Sequence[tuple[int, int]]) -> list[ImageReference]:
    references: list[ImageReference] = []
    cursor = 0
    while True:
        image_start = content.find("![", cursor)
        if image_start < 0:
            break
        if overlaps_ranges(image_start, image_start + 2, protected):
            cursor = image_start + 2
            continue
        if image_start + 2 < len(content) and content[image_start + 2] == "[":
            cursor = image_start + 3
            continue

        alt_end = find_unescaped(content, "]", image_start + 2)
        if alt_end < 0:
            raise PublishError("Unclosed Markdown image alt text", "INVALID_MARKDOWN")
        open_paren = alt_end + 1
        while open_paren < len(content) and content[open_paren] in " \t":
            open_paren += 1
        if open_paren >= len(content) or content[open_paren] != "(":
            cursor = alt_end + 1
            continue

        depth = 1
        escaped = False
        close_paren = -1
        index = open_paren + 1
        while index < len(content):
            char = content[index]
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    close_paren = index
                    break
            index += 1
        if close_paren < 0:
            raise PublishError("Unclosed Markdown image destination", "INVALID_MARKDOWN")

        inner_start = open_paren + 1
        inner = content[inner_start:close_paren]
        leading = len(inner) - len(inner.lstrip())
        destination_start = inner_start + leading
        stripped = inner.lstrip()
        if not stripped:
            raise PublishError("Empty Markdown image destination", "INVALID_MARKDOWN")

        if stripped.startswith("<"):
            closing_angle = stripped.find(">")
            if closing_angle < 0:
                raise PublishError("Unclosed angle-bracket image destination", "INVALID_MARKDOWN")
            destination_start += 1
            destination_end = destination_start + closing_angle - 1
        else:
            nested = 0
            destination_end_relative = len(stripped)
            escaped = False
            for offset, char in enumerate(stripped):
                if escaped:
                    escaped = False
                    continue
                if char == "\\":
                    escaped = True
                elif char == "(":
                    nested += 1
                elif char == ")" and nested:
                    nested -= 1
                elif char.isspace() and nested == 0:
                    destination_end_relative = offset
                    break
            destination_end = destination_start + destination_end_relative

        raw_path = content[destination_start:destination_end]
        if not raw_path:
            raise PublishError("Empty Markdown image destination", "INVALID_MARKDOWN")
        references.append(
            ImageReference(
                kind="markdown",
                start=destination_start,
                end=destination_end,
                raw_path=raw_path,
                alt=content[image_start + 2 : alt_end],
            )
        )
        cursor = close_paren + 1
    return references


def scan_image_references(content: str) -> list[ImageReference]:
    protected = protected_ranges(content)
    unsupported = next(
        (
            match
            for match in REFERENCE_IMAGE.finditer(content)
            if not overlaps_ranges(match.start(), match.end(), protected)
        ),
        None,
    )
    if unsupported:
        raise PublishError(
            f"Reference-style images are not supported: {unsupported.group(0)}",
            "UNSUPPORTED_IMAGE_SYNTAX",
        )

    references = scan_markdown_images(content, protected)
    for match in WIKI_EMBED.finditer(content):
        if overlaps_ranges(match.start(), match.end(), protected):
            continue
        references.append(
            ImageReference(
                kind="wiki",
                start=match.start(),
                end=match.end(),
                raw_path=match.group(1).split("|", 1)[0].strip(),
            )
        )
    for tag in HTML_TAG.finditer(content):
        if overlaps_ranges(tag.start(), tag.end(), protected):
            continue
        src = HTML_SRC.search(tag.group(0))
        if not src:
            if re.search(r"\bsrc\s*=", tag.group(0), re.IGNORECASE):
                raise PublishError("HTML image src must be quoted", "UNSUPPORTED_IMAGE_SYNTAX")
            continue
        references.append(
            ImageReference(
                kind="html",
                start=tag.start() + src.start("src"),
                end=tag.start() + src.end("src"),
                raw_path=src.group("src"),
            )
        )

    references.sort(key=lambda reference: (reference.start, reference.end))
    previous_end = -1
    for reference in references:
        if reference.start < previous_end:
            raise PublishError("Overlapping image references are not supported", "INVALID_MARKDOWN")
        previous_end = reference.end
    return references


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_local_image(raw_path: str, note: Path, vault: Path, permalink: str) -> Path:
    decoded = decode_reference(raw_path)
    if not decoded or is_remote(decoded):
        raise PublishError(f"Not a local image reference: {raw_path}", "INVALID_IMAGE")

    if re.match(r"^[A-Za-z]:/", decoded):
        raise PublishError(
            f"Windows absolute image paths are not portable; use a vault-relative link: {raw_path}",
            "UNSAFE_IMAGE_PATH",
        )

    relative = Path(decoded)
    exact_candidates: list[Path] = []
    if relative.is_absolute():
        exact_candidates.append(relative)
    else:
        exact_candidates.extend(
            [
                note.parent / relative,
                vault / relative,
                vault / "attachments" / relative,
                vault / "attachments" / permalink / relative,
            ]
        )

    resolved_exact: list[Path] = []
    seen: set[Path] = set()
    for candidate in exact_candidates:
        resolved = candidate.expanduser().resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        if not is_within(resolved, vault):
            raise PublishError(f"Image is outside the Obsidian vault: {raw_path}", "UNSAFE_IMAGE_PATH")
        resolved_exact.append(resolved)

    if len(resolved_exact) == 1:
        result = resolved_exact[0]
    elif len(resolved_exact) > 1:
        raise PublishError(f"Ambiguous image reference: {raw_path}", "AMBIGUOUS_IMAGE")
    else:
        basename = relative.name
        hit_set: set[Path] = set()
        for path in vault.rglob(basename):
            if not path.is_file() or ".obsidian" in path.parts:
                continue
            resolved = path.resolve()
            if not is_within(resolved, vault):
                raise PublishError(f"Image symlink escapes the vault: {path}", "UNSAFE_IMAGE_PATH")
            hit_set.add(resolved)
        hits = sorted(hit_set)
        if not hits:
            raise PublishError(f"Missing local image: {raw_path}", "MISSING_IMAGE")
        if len(hits) > 1:
            locations = ", ".join(str(path.relative_to(vault)) for path in hits[:5])
            raise PublishError(f"Ambiguous image '{raw_path}': {locations}", "AMBIGUOUS_IMAGE")
        result = hits[0]

    if result.suffix.lower() not in IMAGE_EXTENSIONS:
        raise PublishError(f"Unsupported image type: {result}", "UNSUPPORTED_IMAGE")
    return result


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def public_asset_url(key: str) -> str:
    return f"{R2_PUBLIC_URL}/{urllib.parse.quote(key, safe='/')}"


def prepare_reference(reference: ImageReference, note: Path, vault: Path, permalink: str) -> None:
    decoded = decode_reference(reference.raw_path)
    if is_remote(decoded):
        return
    local = resolve_local_image(decoded, note, vault, permalink)
    digest = file_sha256(local)
    extension = local.suffix.lower()
    key = f"{ASSET_PREFIX}/{digest}{extension}"
    reference.local_path = local
    reference.sha256 = digest
    reference.object_key = key
    reference.public_url = public_asset_url(key)


def render_content(content: str, references: Sequence[ImageReference]) -> str:
    replacements: list[tuple[int, int, str]] = []
    for reference in references:
        if not reference.public_url:
            continue
        if reference.kind == "wiki":
            alt = reference.local_path.stem if reference.local_path else "image"
            replacement = f"![{alt}]({reference.public_url})"
        else:
            replacement = reference.public_url
        replacements.append((reference.start, reference.end, replacement))

    rendered = content
    for start, end, replacement in sorted(replacements, reverse=True):
        rendered = rendered[:start] + replacement + rendered[end:]
    return rendered


def infer_vault(source: Path, explicit: Path | None) -> Path:
    if explicit:
        vault = explicit.expanduser().resolve()
    elif DEFAULT_VAULT:
        vault = Path(DEFAULT_VAULT).expanduser().resolve()
    elif source.parent.name == "posts":
        vault = source.parent.parent.resolve()
    else:
        raise PublishError("Obsidian vault is unknown; pass --vault or set OBSIDIAN_VAULT", "VAULT_NOT_FOUND")
    if not vault.is_dir():
        raise PublishError(f"Obsidian vault not found: {vault}", "VAULT_NOT_FOUND")
    if not is_within(source, vault):
        raise PublishError(f"Note is outside the Obsidian vault: {source}", "NOTE_OUTSIDE_VAULT")
    return vault


def create_plan(source: Path, vault: Path, output_dir: Path) -> PostPlan:
    source = source.expanduser().resolve()
    if not source.is_file():
        raise PublishError(f"Markdown note not found: {source}", "NOTE_NOT_FOUND")
    if source.suffix.lower() not in {".md", ".mdx"}:
        raise PublishError(f"Unsupported note type: {source}", "INVALID_NOTE")

    content = source.read_text(encoding="utf-8")
    frontmatter = parse_frontmatter(content, source)
    permalink, published, warnings = validate_metadata(frontmatter, source)
    references = scan_image_references(content) if published else []
    for reference in references:
        decoded = decode_reference(reference.raw_path)
        if not is_remote(decoded):
            prepare_reference(reference, source, vault, permalink)

    rendered = render_content(content, references)
    output = output_dir.expanduser().resolve() / f"{permalink}{source.suffix.lower()}"
    return PostPlan(
        source=source,
        output=output,
        permalink=permalink,
        published=published,
        source_content=content,
        rendered_content=rendered,
        references=references,
        warnings=warnings,
    )


class R2Uploader:
    def __init__(self, reporter: Reporter) -> None:
        missing = [
            name
            for name, value in {
                "R2_ACCOUNT_ID": R2_ACCOUNT_ID,
                "R2_ACCESS_KEY_ID": R2_ACCESS_KEY_ID,
                "R2_SECRET_ACCESS_KEY": R2_SECRET_ACCESS_KEY,
                "R2_BUCKET_NAME": R2_BUCKET_NAME,
            }.items()
            if not value
        ]
        if missing:
            raise PublishError(f"Missing R2 configuration: {', '.join(missing)}", "R2_NOT_CONFIGURED")
        self.reporter = reporter
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name="auto",
        )

    def upload(self, path: Path, key: str) -> str:
        try:
            self.client.head_object(Bucket=R2_BUCKET_NAME, Key=key)
            self.reporter.log(f"exists  {key}")
            return "existing"
        except ClientError as error:
            status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            error_code = str(error.response.get("Error", {}).get("Code", ""))
            if status != 404 and error_code not in {"404", "NoSuchKey", "NotFound"}:
                raise PublishError(f"R2 HEAD failed for {key}: {error_code or status}", "R2_ERROR") from error

        content_type, _ = mimetypes.guess_type(path.name)
        extra: dict[str, Any] = {"CacheControl": "public, max-age=31536000, immutable"}
        if content_type:
            extra["ContentType"] = content_type
        self.reporter.log(f"upload  {key}")
        try:
            self.client.upload_file(str(path), R2_BUCKET_NAME, key, ExtraArgs=extra)
        except ClientError as error:
            raise PublishError(f"R2 upload failed for {key}", "R2_ERROR") from error
        return "uploaded"


def upload_assets(plans: Sequence[PostPlan], reporter: Reporter) -> dict[str, int]:
    unique: dict[str, Path] = {}
    for plan in plans:
        for reference in plan.local_assets:
            assert reference.object_key and reference.local_path
            prior = unique.get(reference.object_key)
            if prior and file_sha256(prior) != reference.sha256:
                raise PublishError(f"Asset hash collision: {reference.object_key}", "HASH_COLLISION")
            unique[reference.object_key] = reference.local_path

    if not unique:
        return {"uploaded": 0, "existing": 0}

    uploader = R2Uploader(reporter)
    counts = {"uploaded": 0, "existing": 0}
    for key, path in unique.items():
        outcome = uploader.upload(path, key)
        counts[outcome] += 1
    return counts


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def is_windows_interop_path(path: Path) -> bool:
    return bool(re.match(r"^/mnt/[a-zA-Z](/|$)", path.as_posix()))


def linux_executable(path: Path) -> bool:
    try:
        return path.is_file() and os.access(path, os.X_OK) and not is_windows_interop_path(path)
    except OSError:
        return False


def resolve_node_bin() -> Path | None:
    """Find a Linux Node bin directory, ignoring Windows WSL interop PATH entries."""
    directories: list[Path] = []
    configured = os.getenv("BLOG_NODE_BIN") or NODE_BIN
    if configured:
        directories.append(Path(configured).expanduser())
    directories.extend(Path(part).expanduser() for part in os.environ.get("PATH", "").split(":") if part)
    home = Path.home()
    directories.extend(sorted((home / ".local/share/pi-node").glob("node-*-linux-*/bin"), reverse=True))
    directories.extend(sorted((home / ".nvm/versions/node").glob("*/bin"), reverse=True))
    directories.extend([Path("/usr/local/bin"), Path("/usr/bin")])
    seen: set[str] = set()
    for directory in directories:
        key = str(directory)
        if key in seen:
            continue
        seen.add(key)
        if linux_executable(directory / "node"):
            return directory
    return None


def command_environment() -> dict[str, str]:
    environment = os.environ.copy()
    node_bin = resolve_node_bin()
    if node_bin:
        environment["PATH"] = f"{node_bin}:{environment.get('PATH', '')}"
    return environment


def run(command: Sequence[str], cwd: Path = BLOG_ROOT, capture: bool = False) -> str:
    """Run a subprocess without ever polluting the JSON stdout protocol."""
    try:
        completed = subprocess.run(
            list(command),
            cwd=cwd,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=command_environment(),
        )
    except FileNotFoundError as error:
        raise PublishError(f"Command not found: {command[0]}", "COMMAND_NOT_FOUND") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "").strip()
        suffix = f": {detail}" if detail else ""
        raise PublishError(f"Command failed ({' '.join(command)}){suffix}", "COMMAND_FAILED") from error
    return completed.stdout.strip() if capture and completed.stdout else ""


def git_preflight(branch: str) -> None:
    current = run(["git", "branch", "--show-current"], capture=True)
    if current != branch:
        raise PublishError(f"Expected git branch '{branch}', found '{current}'", "WRONG_BRANCH")
    dirty = run(["git", "status", "--porcelain"], capture=True)
    if dirty:
        raise PublishError("Git working tree must be clean before commit/push", "DIRTY_WORKTREE")
    run(["git", "fetch", "origin", branch])
    behind = run(["git", "rev-list", "--count", f"HEAD..origin/{branch}"], capture=True)
    if behind != "0":
        raise PublishError(f"Local branch is behind origin/{branch} by {behind} commit(s)", "BRANCH_BEHIND")


def build_site(reporter: Reporter) -> None:
    reporter.log("check   npm run check")
    run(["npm", "run", "check"])
    reporter.log("build   npm run build")
    run(["npm", "run", "build"])


def snapshot_outputs(plans: Sequence[PostPlan]) -> dict[Path, bytes | None]:
    return {
        plan.output: plan.output.read_bytes() if plan.output.exists() else None
        for plan in plans
    }


def restore_outputs(snapshot: dict[Path, bytes | None]) -> None:
    for path, content in snapshot.items():
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(f".{path.name}.restore")
            temporary.write_bytes(content)
            os.replace(temporary, path)


def git_remote_guard(branch: str) -> None:
    run(["git", "fetch", "origin", branch])
    behind = run(["git", "rev-list", "--count", f"HEAD..origin/{branch}"], capture=True)
    if behind != "0":
        raise PublishError(f"Remote origin/{branch} advanced during publish", "BRANCH_BEHIND")


def commit_outputs(plans: Sequence[PostPlan], message: str, reporter: Reporter) -> str | None:
    try:
        relative_paths = [str(plan.output.relative_to(BLOG_ROOT)) for plan in plans]
    except ValueError as error:
        raise PublishError("Cannot commit outputs outside the blog repository", "UNSAFE_OUTPUT_PATH") from error
    run(["git", "add", "--", *relative_paths])
    staged = run(["git", "diff", "--cached", "--name-only"], capture=True)
    staged_paths = {line for line in staged.splitlines() if line}
    unexpected = staged_paths.difference(relative_paths)
    if unexpected:
        raise PublishError(f"Refusing to commit unexpected paths: {', '.join(sorted(unexpected))}", "UNSAFE_GIT_DIFF")
    if not staged_paths:
        reporter.log("commit  no generated changes")
        return None
    run(["git", "commit", "-m", message])
    commit = run(["git", "rev-parse", "--short", "HEAD"], capture=True)
    reporter.log(f"commit  {commit}")
    return commit


def discover_sources(source: Path | None, all_posts: bool, vault_arg: Path | None) -> tuple[list[Path], Path]:
    if all_posts:
        if not vault_arg and not DEFAULT_VAULT:
            raise PublishError("--all requires --vault or OBSIDIAN_VAULT", "VAULT_NOT_FOUND")
        vault = (vault_arg or Path(DEFAULT_VAULT)).expanduser().resolve()
        posts = vault / "posts"
        if not posts.is_dir():
            raise PublishError(f"Posts folder not found: {posts}", "POSTS_NOT_FOUND")
        sources = sorted([*posts.rglob("*.md"), *posts.rglob("*.mdx")])
        if not sources:
            raise PublishError(f"No Markdown posts found in {posts}", "POSTS_NOT_FOUND")
        return sources, vault

    if source is None:
        raise PublishError("Specify a note path or use --all", "NOTE_NOT_FOUND")
    resolved = source.expanduser().resolve()
    return [resolved], infer_vault(resolved, vault_arg)


def command_doctor(args: argparse.Namespace) -> dict[str, Any]:
    vault_value = args.vault or (Path(DEFAULT_VAULT) if DEFAULT_VAULT else None)
    vault = vault_value.expanduser().resolve() if vault_value else None
    command_path = command_environment().get("PATH")
    node = shutil.which("node", path=command_path)
    npm = shutil.which("npm", path=command_path)
    checks = {
        "vault": bool(vault and vault.is_dir()),
        "posts": bool(vault and (vault / "posts").is_dir()),
        "repo": (BLOG_ROOT / ".git").is_dir(),
        "node": bool(node) and linux_executable(Path(node)),
        "npm": bool(npm) and linux_executable(Path(npm)),
        "git": shutil.which("git", path=command_path) is not None,
        "r2": all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]),
    }
    branch = None
    remote = None
    if checks["git"] and checks["repo"]:
        try:
            branch = run(["git", "branch", "--show-current"], capture=True)
            remote = run(["git", "remote", "get-url", "origin"], capture=True)
        except PublishError:
            pass
    checks["branch"] = branch == args.branch
    checks["origin"] = bool(remote)
    return {
        "schemaVersion": PROTOCOL_VERSION,
        "ok": all(checks.values()),
        "action": "doctor",
        "checks": checks,
        "vault": str(vault) if vault else None,
        "repo": str(BLOG_ROOT),
        "branch": branch,
        "expectedBranch": args.branch,
        "origin": remote,
        "nodePath": node,
        "npmPath": npm,
    }


def command_notes(args: argparse.Namespace, reporter: Reporter) -> dict[str, Any]:
    sources, vault = discover_sources(args.source, args.all, args.vault)
    output_dir = args.output_dir.expanduser().resolve()
    plans = [create_plan(source, vault, output_dir) for source in sources]
    permalinks = [plan.permalink for plan in plans]
    if len(permalinks) != len(set(permalinks)):
        raise PublishError("Duplicate permalinks found in the selected notes", "DUPLICATE_PERMALINK")

    result: dict[str, Any] = {
        "schemaVersion": PROTOCOL_VERSION,
        "ok": True,
        "action": args.command,
        "posts": [plan.as_dict() for plan in plans],
        "assets": {"uploaded": 0, "existing": 0},
        "build": "skipped",
        "commit": None,
        "push": "skipped",
    }
    if args.command in {"validate", "plan"}:
        return result

    if args.push and not (args.commit and args.build):
        raise PublishError("--push requires --build and --commit", "INVALID_ARGUMENTS")
    if args.commit and not args.build:
        raise PublishError("--commit requires --build", "INVALID_ARGUMENTS")
    if args.commit:
        git_preflight(args.branch)

    published_plans = [plan for plan in plans if plan.published]
    result["assets"] = upload_assets(published_plans, reporter)
    snapshot = snapshot_outputs(plans)
    for plan in plans:
        if plan.published:
            atomic_write(plan.output, plan.rendered_content)
            reporter.log(f"wrote   {plan.output}")
        elif plan.output.exists():
            plan.output.unlink()
            reporter.log(f"removed {plan.output}")

    if args.build:
        try:
            build_site(reporter)
        except PublishError:
            restore_outputs(snapshot)
            reporter.log("restore generated outputs after failed build")
            raise
        result["build"] = "passed"

    if args.commit:
        default_message = (
            f"publish: {plans[0].permalink}"
            if len(plans) == 1
            else f"publish: sync {len(plans)} posts"
        )
        result["commit"] = commit_outputs(plans, args.message or default_message, reporter)

    if args.push:
        if result["commit"]:
            git_remote_guard(args.branch)
            run(["git", "push", "origin", args.branch])
            reporter.log(f"push    origin/{args.branch}")
            result["push"] = "passed"
        else:
            result["push"] = "unchanged"
    return result


def add_note_arguments(parser: argparse.ArgumentParser) -> None:
    selection = parser.add_mutually_exclusive_group(required=False)
    selection.add_argument("source", nargs="?", type=Path, help="Obsidian Markdown note")
    selection.add_argument("--all", action="store_true", help="Process every note in <vault>/posts")
    parser.add_argument("--vault", type=Path, help="Obsidian vault root")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Generated Astro content directory")
    parser.add_argument("--json", action="store_true", help="Write one machine-readable JSON result to stdout")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish Obsidian notes to blog.ljy.app")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in ("validate", "plan"):
        subparser = subparsers.add_parser(name, help=f"{name.capitalize()} note(s) without side effects")
        add_note_arguments(subparser)

    publish = subparsers.add_parser("publish", help="Upload assets and generate Astro Markdown")
    add_note_arguments(publish)
    publish.add_argument("--build", action="store_true", help="Run Astro check and build after generation")
    publish.add_argument("--commit", action="store_true", help="Commit only generated article paths")
    publish.add_argument("--push", action="store_true", help="Push the expected production branch")
    publish.add_argument("--branch", default=DEFAULT_BRANCH, help="Expected production branch")
    publish.add_argument("--message", help="Git commit message")

    doctor = subparsers.add_parser("doctor", help="Check local publishing prerequisites")
    doctor.add_argument("--vault", type=Path, help="Obsidian vault root")
    doctor.add_argument("--branch", default=DEFAULT_BRANCH, help="Expected production branch")
    doctor.add_argument("--json", action="store_true", help="Write one machine-readable JSON result to stdout")

    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    reporter = Reporter(args.json)
    try:
        result = command_doctor(args) if args.command == "doctor" else command_notes(args, reporter)
    except PublishError as error:
        result = {
            "schemaVersion": PROTOCOL_VERSION,
            "ok": False,
            "error": {"code": error.code, "message": str(error)},
        }
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(f"error: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        if args.command in {"validate", "plan"}:
            for post in result["posts"]:
                print(f"{args.command:8} {post['permalink']} -> {post['output']}")
        elif args.command == "doctor":
            for name, passed in result["checks"].items():
                print(f"{'ok' if passed else 'missing':8} {name}")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
