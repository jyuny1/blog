#!/usr/bin/env python3
"""Upload local/Obsidian images to img.ljy.app and rewrite Markdown references."""

from __future__ import annotations

import argparse
import mimetypes
import os
import re
import sys
import urllib.parse
from pathlib import Path

import boto3
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

WIKI_EMBED = re.compile(r"!\[\[([^\]]+)\]\]")
MD_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
HTML_IMAGE = re.compile(r'(<img\b[^>]*\bsrc=["\'])([^"\']+)(["\'])', re.IGNORECASE)
FRONTMATTER_NAME = re.compile(r"^name:\s*[\"']?([^\"'\n]+)[\"']?\s*$", re.MULTILINE)
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg"}


def die(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def slugify(value: str) -> str:
    value = value.strip().replace(" ", "-")
    keep = "".join(ch if ch.isalnum() or ch in "-._" else "-" for ch in value)
    return re.sub(r"-{2,}", "-", keep).strip("-").lower() or "untitled"


def post_slug(path: Path, content: str, override: str | None) -> str:
    if override:
        return slugify(override)
    match = FRONTMATTER_NAME.search(content)
    if match:
        return slugify(match.group(1))
    return slugify(path.stem)


def is_remote(url: str) -> bool:
    return url.startswith(("https://", "http://", "data:", "//"))


def decode_path(raw: str) -> str:
    return urllib.parse.unquote(raw.split("|")[0].strip())


def find_local_image(raw_path: str, md_file: Path, vault: Path | None) -> Path | None:
    decoded = decode_path(raw_path)
    if not decoded or is_remote(decoded):
        return None

    candidates = [Path(decoded), md_file.parent / decoded]
    if vault:
        candidates.append(vault / decoded)

    for candidate in candidates:
        resolved = candidate.expanduser()
        if resolved.is_file():
            return resolved.resolve()

    if vault:
        name = Path(decoded).name
        hits = [p for p in vault.rglob(name) if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
        if len(hits) == 1:
            return hits[0].resolve()
        if len(hits) > 1:
            print(f"Warning: multiple matches for {name}, using {hits[0]}")
            return hits[0].resolve()
    return None


def client():
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
        die(f"Missing {', '.join(missing)}. Copy .env.example to .env first.")

    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


def public_url(key: str) -> str:
    return f"{R2_PUBLIC_URL}/{urllib.parse.quote(key)}"


def upload(s3, file_path: Path, key: str, dry_run: bool) -> str:
    if dry_run:
        print(f"dry-run {file_path} -> {key}")
        return public_url(key)

    extra = {}
    content_type, _ = mimetypes.guess_type(file_path.name)
    if content_type:
        extra["ContentType"] = content_type

    try:
        s3.head_object(Bucket=R2_BUCKET_NAME, Key=key)
        print(f"exists  {key}")
    except ClientError:
        print(f"upload  {key}")
        s3.upload_file(str(file_path), R2_BUCKET_NAME, key, ExtraArgs=extra)
    return public_url(key)


def rewrite(content: str, md_file: Path, vault: Path | None, slug: str, s3, dry_run: bool) -> str:
    def replace_local(raw_path: str, alt: str | None = None) -> str | None:
        local = find_local_image(raw_path, md_file, vault)
        if not local:
            if not is_remote(raw_path):
                print(f"missing {raw_path}")
            return None
        key = f"{slug}/{local.name}"
        url = upload(s3, local, key, dry_run)
        return f"![{alt if alt is not None else local.stem}]({url})"

    def wiki(match: re.Match[str]) -> str:
        return replace_local(match.group(1)) or match.group(0)

    def markdown(match: re.Match[str]) -> str:
        alt, src = match.group(1), match.group(2)
        if is_remote(src):
            return match.group(0)
        return replace_local(src, alt) or match.group(0)

    def html(match: re.Match[str]) -> str:
        prefix, src, suffix = match.group(1), match.group(2), match.group(3)
        if is_remote(src):
            return match.group(0)
        local = find_local_image(src, md_file, vault)
        if not local:
            print(f"missing {src}")
            return match.group(0)
        url = upload(s3, local, f"{slug}/{local.name}", dry_run)
        return f"{prefix}{url}{suffix}"

    content = WIKI_EMBED.sub(wiki, content)
    content = MD_IMAGE.sub(markdown, content)
    return HTML_IMAGE.sub(html, content)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish note images to img.ljy.app")
    parser.add_argument("markdown", type=Path, help="Obsidian note or blog Markdown file")
    parser.add_argument("--vault", type=Path, default=DEFAULT_VAULT, help="Obsidian vault root")
    parser.add_argument("--slug", help="R2 folder / post slug")
    parser.add_argument("--output", type=Path, help="Write rewritten Markdown here")
    parser.add_argument("--in-place", action="store_true", help="Overwrite the source file")
    parser.add_argument("--dry-run", action="store_true", help="Resolve and rewrite without uploading")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = args.markdown.expanduser().resolve()
    if not source.is_file():
        die(f"Markdown not found: {source}")

    vault = args.vault.expanduser().resolve() if args.vault else None
    content = source.read_text(encoding="utf-8")
    slug = post_slug(source, content, args.slug)
    s3 = None if args.dry_run else client()
    rewritten = rewrite(content, source, vault, slug, s3, args.dry_run)

    if args.in_place:
        output = source
    elif args.output:
        output = args.output
    else:
        output = BLOG_ROOT / "src/content/blog" / f"{source.stem}.md"

    output = output.expanduser()
    if not args.dry_run or args.in_place or args.output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rewritten, encoding="utf-8")
        print(f"wrote   {output}")
    print(f"slug    {slug}")


if __name__ == "__main__":
    main()
