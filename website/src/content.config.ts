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
  }),
});

export const collections = { topics };
