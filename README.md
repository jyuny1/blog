# Kevin's Note

A static Astro blog for photography, visual studies, and long-form notes. The visual system mirrors [LJY Photography](https://portfolio.ljy.app): near-black backgrounds, restrained gold accents, serif display type, and compact uppercase navigation.

## Commands

```bash
npm install
npm run dev
npm run check
npm run build
npm run preview
```

## Images (Obsidian → img.ljy.app)

Write in Obsidian with local embeds. Do not commit binaries. Upload at publish time:

```markdown
![[macro-winner.jpg]]
![Alt](attachments/macro-winner.jpg)
```

```bash
pip install -r requirements.txt
cp .env.example .env   # fill R2_* and OBSIDIAN_VAULT

python publish.py "/path/to/vault/攝影/upy.md" --slug upy-macro-rank-analysis-2019-2025
python publish.py src/content/blog/upy-macro-rank-analysis-2019-2025.md --in-place --dry-run
```

The script uploads to `https://img.ljy.app/{slug}/{filename}` and rewrites the note into `src/content/blog/`. Existing remote URLs are left unchanged. Keep Cloudflare Hotlink Protection allowed for `blog.ljy.app`.

## Content

Published articles live in `src/content/blog/`. Frontmatter supports:

```yaml
---
title: Article title
description: A short summary
date: 2026-01-24
tags:
  - Photography
status: draft # optional; drafts are excluded
image: https://example.com/social-image.jpg # optional
---
```

Obsidian callouts and `==highlights==` are handled by `src/plugins/remark-callouts.mjs`.

## AI crawler policy

`public/robots.txt` allows conventional search indexing but opts out of AI input and training, and disallows known AI crawler user agents. Because `robots.txt` is voluntary, enforce the policy in Cloudflare as well:

1. Open the `blog.ljy.app` zone in Cloudflare.
2. Go to **AI Crawl Control → Crawlers**.
3. Block AI training and answer-engine crawlers.
4. Keep conventional search crawlers allowed.

## Deployment

Build output is written to `dist/`. Deploy that directory to any static host. The canonical site URL is configured in `astro.config.mjs` as `https://blog.ljy.app`.
