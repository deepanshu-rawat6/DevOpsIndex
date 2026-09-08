import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const topics = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/topics' }),
  schema: z.object({
    section: z.string(),
    sectionTitle: z.string(),
    sectionOrder: z.number(),
    pageSlug: z.string(),
    title: z.string(),
    filePath: z.string(),
    pageOrder: z.number(),
    prerequisites: z.array(z.object({ title: z.string(), slug: z.string() })).optional().default([]),
  }),
});

export const collections = { topics };
