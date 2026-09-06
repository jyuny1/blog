import { defineConfig } from "astro/config"
import sitemap from "@astrojs/sitemap"
import { unified } from "@astrojs/markdown-remark"
import remarkCallouts, {
  rehypeImages,
  remarkDropDuplicateTitle,
} from "./src/plugins/remark-callouts.mjs"

export default defineConfig({
  site: "https://blog.ljy.app",
  output: "static",
  integrations: [sitemap()],
  markdown: {
    processor: unified({
      remarkPlugins: [remarkDropDuplicateTitle, remarkCallouts],
      rehypePlugins: [rehypeImages],
    }),
    shikiConfig: {
      theme: "github-light",
      wrap: true,
    },
  },
})
