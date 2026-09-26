from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import publish


class PublisherTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.vault = self.root / "vault"
        self.posts = self.vault / "posts"
        self.attachments = self.vault / "attachments"
        self.output = self.root / "output"
        self.posts.mkdir(parents=True)
        self.attachments.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def note(
        self,
        body: str = "Body\n",
        *,
        name: str = "post.md",
        permalink: str = "post",
        published: bool = True,
        extra: str = "",
    ) -> Path:
        path = self.posts / name
        path.write_text(
            "---\n"
            "title: Test post\n"
            f"permalink: {permalink}\n"
            f"published: {'true' if published else 'false'}\n"
            "tags:\n"
            "  - test\n"
            f"{extra}"
            "---\n"
            f"{body}",
            encoding="utf-8",
        )
        return path

    def test_remote_images_are_preserved(self) -> None:
        source = self.note(
            "![remote](https://img.ljy.app/existing.jpg)\n"
            '<img src="https://example.com/a.png">\n',
        )
        plan = publish.create_plan(source, self.vault, self.output)
        self.assertEqual(plan.rendered_content, plan.source_content)
        self.assertEqual(plan.local_assets, [])
        self.assertEqual(len(plan.references), 2)

    def test_local_image_syntaxes_are_rewritten_to_one_hashed_asset(self) -> None:
        image = self.attachments / "photo (one).jpg"
        image.write_bytes(b"same image")
        digest = hashlib.sha256(b"same image").hexdigest()
        source = self.note(
            "![[photo (one).jpg|600]]\n"
            '![Alt](<../attachments/photo (one).jpg> "Title")\n'
            '<img class="hero" src="../attachments/photo%20%28one%29.jpg">\n'
        )

        plan = publish.create_plan(source, self.vault, self.output)
        url = f"https://img.ljy.app/blog-assets/{digest}.jpg"
        self.assertEqual(len(plan.references), 3)
        self.assertEqual(len({ref.object_key for ref in plan.local_assets}), 1)
        self.assertIn(f"![photo (one)]({url})", plan.rendered_content)
        self.assertIn(f'![Alt](<{url}> "Title")', plan.rendered_content)
        self.assertIn(f'<img class="hero" src="{url}">', plan.rendered_content)

    def test_images_inside_code_and_comments_are_ignored(self) -> None:
        source = self.note(
            "```md\n![[missing.png]]\n```\n"
            "`![x](missing.png)`\n"
            "<!-- ![x](missing.png) -->\n"
        )
        plan = publish.create_plan(source, self.vault, self.output)
        self.assertEqual(plan.references, [])
        self.assertEqual(plan.rendered_content, plan.source_content)

    def test_reference_style_image_fails_closed(self) -> None:
        source = self.note("![photo][hero]\n\n[hero]: ../attachments/photo.jpg\n")
        with self.assertRaisesRegex(publish.PublishError, "Reference-style") as raised:
            publish.create_plan(source, self.vault, self.output)
        self.assertEqual(raised.exception.code, "UNSUPPORTED_IMAGE_SYNTAX")

    def test_unquoted_html_src_fails_closed(self) -> None:
        source = self.note("<img src=../attachments/photo.jpg>\n")
        with self.assertRaises(publish.PublishError) as raised:
            publish.create_plan(source, self.vault, self.output)
        self.assertEqual(raised.exception.code, "UNSUPPORTED_IMAGE_SYNTAX")

    def test_missing_and_ambiguous_images_fail(self) -> None:
        missing = self.note("![[missing.jpg]]\n")
        with self.assertRaises(publish.PublishError) as raised:
            publish.create_plan(missing, self.vault, self.output)
        self.assertEqual(raised.exception.code, "MISSING_IMAGE")

        (self.attachments / "a").mkdir()
        (self.attachments / "b").mkdir()
        (self.attachments / "a" / "duplicate.jpg").write_bytes(b"a")
        (self.attachments / "b" / "duplicate.jpg").write_bytes(b"b")
        ambiguous = self.note("![[duplicate.jpg]]\n", name="ambiguous.md", permalink="ambiguous")
        with self.assertRaises(publish.PublishError) as raised:
            publish.create_plan(ambiguous, self.vault, self.output)
        self.assertEqual(raised.exception.code, "AMBIGUOUS_IMAGE")

    def test_symlink_outside_vault_fails(self) -> None:
        outside = self.root / "outside.jpg"
        outside.write_bytes(b"secret")
        link = self.attachments / "escape.jpg"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("symlinks unavailable")
        source = self.note("![[escape.jpg]]\n")
        with self.assertRaises(publish.PublishError) as raised:
            publish.create_plan(source, self.vault, self.output)
        self.assertEqual(raised.exception.code, "UNSAFE_IMAGE_PATH")

    def test_permalink_and_metadata_validation(self) -> None:
        for value in ("Uppercase", "has space", "../escape", "has/slash", "bad%20"):
            source = self.note(name=f"{len(value)}.md", permalink=value)
            with self.subTest(value=value), self.assertRaises(publish.PublishError):
                publish.create_plan(source, self.vault, self.output)

        unicode_source = self.note(name="unicode.md", permalink="台灣零售")
        plan = publish.create_plan(unicode_source, self.vault, self.output)
        self.assertEqual(plan.output.name, "台灣零售.md")

    def test_missing_published_defaults_private(self) -> None:
        source = self.posts / "private.md"
        source.write_text("---\ntitle: Private\npermalink: private\n---\nBody\n", encoding="utf-8")
        plan = publish.create_plan(source, self.vault, self.output)
        self.assertFalse(plan.published)
        self.assertEqual(plan.as_dict()["disposition"], "remove")
        self.assertTrue(plan.warnings)

    def test_private_notes_do_not_resolve_unfinished_images(self) -> None:
        source = self.note(body="![[not-ready.jpg]]\n", published=False)
        plan = publish.create_plan(source, self.vault, self.output)
        self.assertFalse(plan.published)
        self.assertEqual(plan.references, [])

    def test_private_publish_removes_generated_output(self) -> None:
        source = self.note(published=False)
        generated = self.output / "post.md"
        generated.parent.mkdir(parents=True)
        generated.write_text("old draft", encoding="utf-8")
        args = argparse.Namespace(
            command="publish",
            source=source,
            all=False,
            vault=self.vault,
            output_dir=self.output,
            push=False,
            commit=False,
            build=False,
            branch="v5",
            message=None,
        )
        result = publish.command_notes(args, publish.Reporter(json_mode=True))
        self.assertTrue(result["ok"])
        self.assertFalse(generated.exists())

    def test_failed_build_restores_previous_output(self) -> None:
        source = self.note(body="New body\n")
        generated = self.output / "post.md"
        generated.parent.mkdir(parents=True)
        generated.write_text("old body", encoding="utf-8")
        args = argparse.Namespace(
            command="publish",
            source=source,
            all=False,
            vault=self.vault,
            output_dir=self.output,
            push=False,
            commit=False,
            build=True,
            branch="v5",
            message=None,
        )
        with mock.patch.object(
            publish,
            "build_site",
            side_effect=publish.PublishError("bad build", "COMMAND_FAILED"),
        ):
            with self.assertRaises(publish.PublishError):
                publish.command_notes(args, publish.Reporter(json_mode=True))
        self.assertEqual(generated.read_text(encoding="utf-8"), "old body")

    def test_duplicate_permalinks_fail(self) -> None:
        first = self.note(name="first.md", permalink="same")
        self.note(name="second.md", permalink="same")
        args = argparse.Namespace(
            command="validate",
            source=None,
            all=True,
            vault=self.vault,
            output_dir=self.output,
        )
        with self.assertRaises(publish.PublishError) as raised:
            publish.command_notes(args, publish.Reporter(json_mode=True))
        self.assertEqual(raised.exception.code, "DUPLICATE_PERMALINK")
        self.assertTrue(first.exists())

    def test_json_cli_stdout_is_one_document(self) -> None:
        source = self.note()
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exit_code = publish.main(
                [
                    "validate",
                    str(source),
                    "--vault",
                    str(self.vault),
                    "--output-dir",
                    str(self.output),
                    "--json",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertTrue(payload["ok"])
        self.assertNotIn("validate", stderr.getvalue())

    def test_windows_interop_paths_are_detected(self) -> None:
        self.assertTrue(publish.is_windows_interop_path(Path("/mnt/c/Program Files/nodejs/npm")))
        self.assertFalse(publish.is_windows_interop_path(Path("/usr/bin/node")))
        self.assertFalse(publish.is_windows_interop_path(Path("/home/jyuny1/.local/share/pi-node/bin/node")))

    def test_resolve_node_bin_prefers_linux_over_windows_interop(self) -> None:
        linux = self.root / "linux-node" / "bin"
        linux.mkdir(parents=True)
        node = linux / "node"
        node.write_text("#!/bin/sh\n", encoding="utf-8")
        node.chmod(0o755)
        environment = {
            "PATH": "/mnt/c/Program Files/nodejs:/usr/bin",
            "HOME": str(self.root / "home"),
        }
        with mock.patch.object(publish, "NODE_BIN", str(linux)), mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(publish.resolve_node_bin(), linux)
            path = publish.command_environment()["PATH"]
            self.assertTrue(path.startswith(f"{linux}:"))

    def test_resolve_node_bin_ignores_windows_only_path(self) -> None:
        environment = {
            "PATH": "/mnt/c/Program Files/nodejs",
            "HOME": str(self.root / "missing-home"),
        }
        with mock.patch.object(publish, "NODE_BIN", None), mock.patch.dict(os.environ, environment, clear=True):
            self.assertIsNone(publish.resolve_node_bin())


if __name__ == "__main__":
    unittest.main()
