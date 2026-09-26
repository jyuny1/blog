import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { z } from "astro/zod"

const blog = defineCollection({
  loader: glob({
    pattern: "**/*.{md,mdx}",
    base: "./src/content/blog",
    generateId: ({ entry }) => entry.replace(/\.(md|mdx)$/i, ""),
  }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date().optional(),
    updated: z.coerce.date().optional(),
    tags: z.preprocess((value) => value ?? [], z.array(z.string())).default([]),
    status: z.string().optional(),
    published: z.boolean().default(false),
    permalink: z.string(),
    draft: z.boolean().default(false),
    image: z.string().optional(),
    author: z.string().optional(),
    aliases: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
    name: z.string().optional(),
  }),
})

export const collections = { blog }
