// `pnpm check:doc-links` — every internal link on the built site lands on a page and an
// element ID that Astro actually rendered, and README.md's links into the published docs do too.
// It reads website/dist after `pnpm --dir website build`, so Starlight's own slugger, link
// rewriting, and clean URLs are what get checked. External URLs are skipped (no network).
//
// The HTML is parsed with regexes on purpose: it is Astro's generated output, which always
// writes attributes double-quoted with `&`, `"`, `<`, `>` entity-escaped, so `id="…"` and
// `href="…"` cannot contain an unescaped quote.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(REPO_ROOT, 'website/dist');
const DOCS_SOURCE_DIR = 'website/docs';
// The site is built at the domain root (astro.config.mjs sets no `base`).
const BASE = '/';
// README links to the published site, whose root is this URL.
const PUBLISHED_SITE = 'https://agent-device.dev/';
const README_DOCS_URL = /https:\/\/agent-device\.dev\/docs\/[\w./-]*(?:#[\w%.-]+)?/g;

export type DocLinkViolation = {
  /** Built page route (`docs/sessions`), or `README.md:<line>`. */
  readonly where: string;
  readonly message: string;
};

type BuiltPage = { readonly ids: ReadonlySet<string>; readonly hrefs: readonly string[] };

const ATTRIBUTE = (name: string) => new RegExp(`\\s${name}="([^"]*)"`, 'g');
const HEADING_ID = /<h[1-6]\b[^>]*\sid="([^"]*)"/g;

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function listHtml(buildDir: string): string[] {
  return (fs.readdirSync(buildDir, { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((entry) => entry.endsWith('.html'))
    .sort();
}

function duplicateHeadingIds(route: string, html: string): DocLinkViolation[] {
  const seen = new Set<string>();
  const violations: DocLinkViolation[] = [];
  for (const [, raw] of html.matchAll(HEADING_ID)) {
    const id = decodeEntities(raw ?? '');
    if (seen.has(id))
      violations.push({ where: route, message: `heading ID "${id}" is rendered twice` });
    seen.add(id);
  }
  return violations;
}

/** The built file a site path names: `docs/x` → `docs/x.html`, `` → `index.html`. */
function builtFile(sitePath: string, buildDir: string): string | null {
  const trimmed = sitePath.replace(/\/$/, '');
  const candidates =
    trimmed === ''
      ? ['index.html']
      : path.posix.extname(trimmed) !== ''
        ? [trimmed]
        : [`${trimmed}.html`, `${trimmed}/index.html`];
  return candidates.find((candidate) => fs.existsSync(path.join(buildDir, candidate))) ?? null;
}

function splitHref(href: string): { target: string; fragment: string | null } {
  const [beforeHash = '', ...rest] = href.split('#');
  return {
    target: beforeHash.replace(/\?.*$/, ''),
    fragment: rest.length > 0 ? decodeFragment(rest.join('#')) : null,
  };
}

type Site = { readonly buildDir: string; readonly pages: ReadonlyMap<string, BuiltPage> };

/** Why a site path (relative to the base) plus fragment does not resolve, or null when it does. */
function resolveProblem(site: Site, sitePath: string, fragment: string | null): string | null {
  const file = builtFile(sitePath, site.buildDir);
  if (file === null) return 'no such page';
  if (!fragment) return null;
  const page = site.pages.get(file);
  if (!page || page.ids.has(fragment)) return null;
  return `no heading "${fragment}"`;
}

function pageViolations(
  site: Site,
  file: string,
  page: BuiltPage,
  base: string,
): DocLinkViolation[] {
  const route = file.replace(/\.html$/, '');
  return page.hrefs.flatMap((href) => {
    const { target, fragment } = splitHref(href);
    let problem: string | null = null;
    if (target === '') {
      problem = fragment && !page.ids.has(fragment) ? `no heading "${fragment}"` : null;
    } else if (target.startsWith(base)) {
      problem = resolveProblem(site, target.slice(base.length), fragment);
    }
    return problem ? [{ where: route, message: `link "${href}" → ${problem}` }] : [];
  });
}

function readmeViolations(site: Site, readmeText: string): DocLinkViolation[] {
  return readmeText.split('\n').flatMap((line, index) =>
    [...line.matchAll(README_DOCS_URL)].flatMap(([match]) => {
      // Sentence punctuation after a bare URL is not part of it, as in GFM autolinks.
      const url = match.replace(/[.,:;]+$/, '');
      const { target, fragment } = splitHref(url);
      const problem = resolveProblem(site, target.slice(PUBLISHED_SITE.length), fragment);
      return problem
        ? [{ where: `README.md:${index + 1}`, message: `link "${url}" → ${problem}` }]
        : [];
    }),
  );
}

/**
 * Check a built site. `base` is the base it was built with, with leading and trailing
 * slashes (`/agent-device/`); internal hrefs start with it. README's URLs name the published site.
 */
export function checkDocLinks(
  buildDir: string,
  readmeText: string,
  base: string,
): DocLinkViolation[] {
  const pages = new Map<string, BuiltPage>();
  const violations: DocLinkViolation[] = [];
  for (const file of listHtml(buildDir)) {
    const html = fs.readFileSync(path.join(buildDir, file), 'utf8');
    const ids = new Set(
      [...html.matchAll(ATTRIBUTE('id'))].map(([, id]) => decodeEntities(id ?? '')),
    );
    const hrefs = [...html.matchAll(ATTRIBUTE('href'))].map(([, href]) =>
      decodeEntities(href ?? ''),
    );
    pages.set(file, { ids, hrefs });
    violations.push(...duplicateHeadingIds(file.replace(/\.html$/, ''), html));
  }
  const site = { buildDir, pages };
  for (const [file, page] of pages) violations.push(...pageViolations(site, file, page, base));
  return [...violations, ...readmeViolations(site, readmeText)];
}

function sourceHint(where: string): string {
  const source = `${DOCS_SOURCE_DIR}/${where}.md`;
  return fs.existsSync(path.join(REPO_ROOT, source)) ? ` (${source})` : '';
}

function main(): number {
  if (!fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
    process.stderr.write(
      'doc links: website/dist is missing; run `pnpm --dir website build` first.\n',
    );
    return 1;
  }
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const violations = checkDocLinks(BUILD_DIR, readme, BASE);
  if (violations.length === 0) {
    process.stdout.write('doc links: every internal link resolves.\n');
    return 0;
  }
  for (const { where, message } of violations) {
    process.stderr.write(`${where}: ${message}${sourceHint(where)}\n`);
  }
  process.stderr.write(
    `doc links: ${violations.length} broken link(s) or duplicate heading ID(s).\n`,
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
