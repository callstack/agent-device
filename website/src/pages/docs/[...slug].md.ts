// /docs/<page>.md: every docs page as Markdown, for LLM clients that fetch one page. The title
// comes from the frontmatter, so the file reads like the rendered page. vercel.json serves these
// as text/markdown, and check-doc-links fails a docs page without its twin.
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection, type CollectionEntry } from 'astro:content';

export const getStaticPaths = (async () =>
  (await getCollection('docs')).map((entry) => ({
    params: { slug: entry.id.replace(/^docs\//, '') },
    props: { entry },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: CollectionEntry<'docs'> }> = ({ props: { entry } }) =>
  new Response(`# ${entry.data.title}\n\n${(entry.body ?? '').trim()}\n`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
