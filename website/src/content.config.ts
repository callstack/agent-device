import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// The docs stay in docs/docs/*.md, where the repo's guards and generators read them
// (capability matrix, command coverage, client API snippets). Their ids keep the `docs/` prefix,
// so every page is served at /docs/<name>.
export const collections = {
  docs: defineCollection({
    loader: glob({ base: './docs', pattern: 'docs/**/[^_]*.{md,mdx}' }),
    schema: docsSchema(),
  }),
};
