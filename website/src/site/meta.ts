// One title pattern for every page, built here and nowhere else: the home page is
// "Name: subtitle", every other page (404, docs, any extra page) is "Page title | Name".
// Site.astro uses fullTitle() for pages outside the docs; astro.config.mjs hands Starlight the
// same delimiter, and routeData.ts sets the docs' social titles from fullTitle(), so <title>,
// og:title and twitter:title always agree.
import { site } from './content.ts';

/** Starlight's own default separator, so docs titles need no override. */
export const TITLE_DELIMITER = '|';

/** The full title for a page; no page title means the home page. */
export function fullTitle(pageTitle?: string): string {
  return pageTitle
    ? `${pageTitle} ${TITLE_DELIMITER} ${site.name}`
    : `${site.name}: ${site.subtitle}`;
}
