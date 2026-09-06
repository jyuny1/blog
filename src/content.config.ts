import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { z } from "astro/zod"

const blog = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date().optional(),
    updated: z.coerce.date().optional(),
    tags: z.preprocess((value) => value ?? [], z.array(z.string())).default([]),
    status: z.string().optional(),
    draft: z.boolean().default(false),
    image: z.string().optional(),
    author: z.string().optional(),
    aliases: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
    name: z.string().optional(),
  }),
})

export const collections = { blog }
