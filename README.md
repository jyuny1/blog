# Kevin's Note

A static Astro blog for photography, visual studies, and long-form notes. Obsidian is the canonical writing source; this repository contains the generated publication copy used by `blog.ljy.app`.

## Architecture

```text
Obsidian: D:\obsidian\blog
  posts/*.md
  attachments/*
        │
        │ LJY Blog Publisher (desktop plugin)
        ▼
WSL: publish.py
  validate → upload images → generate Markdown
  → Astro check/build → commit/push v5
        │                         │
        ▼                         ▼
Cloudflare R2              Cloudflare Pages
img.ljy.app                blog.ljy.app
```

- Edit articles only in the Obsidian `blog` vault.
- `src/content/blog/` is generated output; do not use it as the authoring source.
- Only notes with `published: true` are generated. Publishing a note with `published: false` removes its generated copy.
- `permalink` is immutable after publication and maps directly to `/posts/{permalink}/`.

## Obsidian vault

```text
D:\obsidian\blog\
├── posts\
├── attachments\
├── templates\
│   └── Blog Post.md
└── .obsidian\plugins\ljy-blog-publisher\
```

New attachments use the global `attachments/` folder. The vault article keeps its local Obsidian embed; only the generated publication copy is rewritten to an R2 URL.

### Frontmatter

```yaml
---
title: Article title
description: A short summary
date: 2026-01-24
tags:
  - Photography
status: draft # free-form editorial status
permalink: article-title
published: false
image: https://example.com/social-image.jpg # optional
---
```

Publication is fail-closed: missing `published` defaults to private. `status` remains free-form metadata and does not control visibility.

## One-click publishing plugin

The local plugin source is in `obsidian-plugin/`. It is desktop-only because it calls WSL without exposing R2 or Git credentials to Obsidian.

Commands:

- **Validate current note** — validate metadata and image references without side effects.
- **Publish current note** — show the plan, upload new images, generate the post, build, then confirm before pushing.
- **Sync all published posts** — preview all generate/remove actions before synchronizing the vault.
- **Check publishing setup** — verify the vault, WSL publisher, R2 configuration, Git branch, Node, and npm.

Build and install locally:

```bash
cd obsidian-plugin
npm install
npm run build

mkdir -p /mnt/d/obsidian/blog/.obsidian/plugins/ljy-blog-publisher
cp main.js manifest.json styles.css \
  /mnt/d/obsidian/blog/.obsidian/plugins/ljy-blog-publisher/
```

Then open **Obsidian → Settings → Community plugins**, enable **LJY Blog Publisher**, and run **Check publishing setup**. The default settings target this repository and branch `v5`.

## Publisher CLI

Create the Python environment:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

Configure the R2 values and vault path in `.env`:

```dotenv
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=https://img.ljy.app
OBSIDIAN_VAULT=/mnt/d/obsidian/blog
BLOG_PUBLISH_BRANCH=v5
BLOG_NODE_BIN=/home/you/.local/share/pi-node/node-v22.23.1-linux-x64/bin
```

`BLOG_NODE_BIN` is required when `wsl.exe --exec` does not load the interactive shell profile containing Node.js.

Commands:

```bash
# Read-only checks
.venv/bin/python publish.py doctor --vault /mnt/d/obsidian/blog
.venv/bin/python publish.py validate "/mnt/d/obsidian/blog/posts/example.md"
.venv/bin/python publish.py plan --all --vault /mnt/d/obsidian/blog

# Generate only
.venv/bin/python publish.py publish "/mnt/d/obsidian/blog/posts/example.md" --build

# Full production publication
.venv/bin/python publish.py publish "/mnt/d/obsidian/blog/posts/example.md" \
  --build --commit --push --branch v5
```

Use `--json` for the plugin-facing protocol. `validate` and `plan` have zero side effects.

## Image flow

Supported local image forms:

```markdown
![[photo.jpg]]
![[photo.jpg|600]]
![Alt](../attachments/photo.jpg)
<img src="../attachments/photo.jpg">
```

New local images are uploaded as immutable content-addressed objects:

```text
https://img.ljy.app/blog-assets/{sha256}.{extension}
```

This provides deduplication and cache busting: unchanged bytes keep the same URL; changed bytes receive a new URL. Existing remote image URLs are preserved and are not downloaded or re-uploaded.

The parser is intentionally fail-closed. Unsupported or ambiguous image syntax stops publication instead of guessing. Images inside fenced code, inline code, or HTML comments are ignored.

## Development

```bash
npm install
npm run dev
npm run check
npm run build
.venv/bin/python -m unittest discover -s tests -v
npm --prefix obsidian-plugin run build
```

Obsidian callouts and `==highlights==` are handled by `src/plugins/remark-callouts.mjs`.

## Deployment

Astro writes the static site to `dist/`. The canonical URL is configured as `https://blog.ljy.app`.

The repository default branch is `v5`. Confirm in Cloudflare Pages that:

1. the production branch is `v5`;
2. the build command runs the Astro checks/build;
3. `blog.ljy.app` is attached to the production deployment.

## AI crawler policy

`public/robots.txt` allows conventional search indexing but opts out of AI input and training. Because `robots.txt` is voluntary, also enforce the policy in Cloudflare **AI Crawl Control**.
