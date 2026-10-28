// Route data for docs pages: a meta description per page, and BreadcrumbList structured data.
// Docs pages have no `description` frontmatter, so Starlight would give every page the
// site-wide one; the first paragraph of the page says what the page is about, so use it.
import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data';

import { docs, site as meta } from './site/content';
import { fullTitle } from './site/meta';

const MAX = 160;

/** The first prose paragraph of a Markdown body, as plain text, cut to fit a description. */
function describe(body: string): string | undefined {
  const blocks = body
    .replaceAll(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim());
  const prose = blocks.find(
    (b) => b && !/^(import |export |:::|#|!\[|\||[-*+] |\d+\. |<|>)/.test(b),
  );
  if (!prose) return undefined;
  const text = prose
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/[`*]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const sentence = cut.lastIndexOf('. ');
  return sentence > 80 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

type Head = StarlightRouteData['head'];

/** Sets the content of every meta tag `matches` picks. */
function setMeta(
  head: Head,
  matches: (attrs: Record<string, unknown>) => boolean,
  content: string,
) {
  for (const tag of head) {
    if (tag.tag === 'meta' && tag.attrs && matches(tag.attrs)) tag.attrs.content = content;
  }
}

/**
 * Pages are built as files (`build.format: 'file'`), so Starlight's canonical and og:url end in
 * .html; Vercel serves them without it (`cleanUrls`), so point both at the clean URL.
 */
function dropHtmlSuffix(head: Head) {
  for (const tag of head) {
    const attrs = tag.attrs;
    if (tag.tag === 'link' && attrs?.rel === 'canonical' && typeof attrs.href === 'string') {
      attrs.href = attrs.href.replace(/\.html$/, '');
    }
    if (tag.tag === 'meta' && attrs?.property === 'og:url' && typeof attrs.content === 'string') {
      attrs.content = attrs.content.replace(/\.html$/, '');
    }
  }
}

type SidebarEntry = StarlightRouteData['sidebar'][number];

/**
 * Starlight writes sidebar and prev/next hrefs as built files (`/docs/x.html`); Vercel serves
 * `/docs/x` (`cleanUrls`), so link there directly instead of through a redirect.
 */
function dropHtmlLinks(entries: SidebarEntry[]) {
  for (const entry of entries) {
    if (entry.type === 'link') entry.href = entry.href.replace(/\.html(#|$)/, '$1');
    else dropHtmlLinks(entry.entries);
  }
}

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  dropHtmlLinks(route.sidebar);
  for (const link of [route.pagination.prev, route.pagination.next]) {
    if (link) link.href = link.href.replace(/\.html(#|$)/, '$1');
  }
  const { entry, head } = route;
  const site = context.site?.href ?? `${meta.url}/`;

  // The same social titles as the landing pages (Site.astro): og:title is the full title, not the
  // page title alone, and Twitter gets its own title and description too.
  const title = fullTitle(entry.data.title);
  setMeta(head, (attrs) => attrs.property === 'og:title', title);
  head.push({ tag: 'meta', attrs: { name: 'twitter:title', content: title } });
  dropHtmlSuffix(head);

  const body = 'body' in entry && typeof entry.body === 'string' ? entry.body : undefined;
  const description = !entry.data.description && body ? describe(body) : undefined;
  if (description) {
    entry.data.description = description;
    setMeta(
      head,
      (attrs) => attrs.name === 'description' || attrs.property === 'og:description',
      description,
    );
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
