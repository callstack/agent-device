// Route data for docs pages: a meta description per page, and BreadcrumbList structured data.
// Docs pages have no `description` frontmatter, so Starlight would give every page the
// site-wide one; the first paragraph of the page says what the page is about, so use it.
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

import { docs, site as meta } from './site/content';
import { fullTitle } from './site/meta';

const MAX = 160;

/** The first prose paragraph of a Markdown body, as plain text, cut to fit a description. */
export function describe(body: string): string | undefined {
  const blocks = body
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim());
  const prose = blocks.find(
    (b) => b && !/^(import |export |:::|#|!\[|\||[-*+] |\d+\. |<|>)/.test(b),
  );
  if (!prose) return undefined;
  const text = prose
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const sentence = cut.lastIndexOf('. ');
  return sentence > 80 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const { entry, head } = route;
  const site = context.site?.href ?? `${meta.url}/`;

  // The same social titles as the landing pages (Site.astro): og:title is the full title, not the
  // page title alone, and Twitter gets its own title and description too.
  const title = fullTitle(entry.data.title);
  for (const tag of head) {
    if (tag.tag === 'meta' && tag.attrs?.property === 'og:title') tag.attrs.content = title;
  }
  head.push({ tag: 'meta', attrs: { name: 'twitter:title', content: title } });

  // Pages are built as files (`build.format: 'file'`), so Starlight's canonical and og:url end
  // in .html; Vercel serves them without it (`cleanUrls`), so point both at the clean URL.
  for (const tag of head) {
    if (
      tag.tag === 'link' &&
      tag.attrs?.rel === 'canonical' &&
      typeof tag.attrs.href === 'string'
    ) {
      tag.attrs.href = tag.attrs.href.replace(/\.html$/, '');
    }
    if (
      tag.tag === 'meta' &&
      tag.attrs?.property === 'og:url' &&
      typeof tag.attrs.content === 'string'
    ) {
      tag.attrs.content = tag.attrs.content.replace(/\.html$/, '');
    }
  }

  if (!entry.data.description && 'body' in entry && typeof entry.body === 'string') {
    const description = describe(entry.body);
    if (description) {
      entry.data.description = description;
      for (const tag of head) {
        if (tag.tag !== 'meta') continue;
        if (tag.attrs?.name === 'description' || tag.attrs?.property === 'og:description')
          tag.attrs.content = description;
      }
    }
  }

  // After the description is settled above, so Twitter shows the same one as search and og.
  head.push({
    tag: 'meta',
    attrs: { name: 'twitter:description', content: entry.data.description ?? meta.description },
  });

  // The product, Docs, this page. Sidebar groups have no page of their own, and every breadcrumb
  // but the last needs a URL, so they are left out.
  const items = [
    { name: meta.name, item: site },
    { name: 'Docs', item: new URL(docs.intro, site).href },
    {
      name: entry.data.title,
      item: new URL(context.url.pathname.replace(/\.html$/, ''), site).href,
    },
  ];
  head.push({
    tag: 'script',
    attrs: { type: 'application/ld+json' },
    content: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, ...it })),
    }),
  });
});
