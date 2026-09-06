import rss from "@astrojs/rss"
import { getCollection } from "astro:content"
import { byNewest, isPublished, SITE_DESCRIPTION, SITE_TITLE } from "../consts"

export async function GET(context: { site?: URL }) {
  const posts = (await getCollection("blog", ({ data }) => isPublished(data)))
    .filter((post) => post.data.date)
    .sort(byNewest)

  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date!,
      link: `/posts/${post.id}/`,
      categories: post.data.tags,
    })),
  })
}
