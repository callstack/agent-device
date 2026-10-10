// `pnpm check:doc-links` — internal links in the user docs must land on a page and heading that
// exist. Reads website/docs Markdown and README.md; external URLs are skipped (no network).
//
// Heading IDs come from rspress's own slugger and custom-ID parser, resolved through the website
// package's @rspress/core, so the IDs checked here are the IDs that version renders. The heading
// text fed to the slugger mirrors rspress's `rehypeHeaderAnchor`: direct text, inline code, and
// the direct text of a formatted or linked span; deeper nesting is dropped there and here.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_DIR = 'website/docs';
const PUBLISHED_ORIGIN = 'https://oss.callstack.com/agent-device';

type Slugger = { slug(value: string): string };

const rspressShared = createRequire(
  createRequire(path.join(REPO_ROOT, 'website/package.json')).resolve('@rspress/core/package.json'),
);
const { default: RspressSlugger } = (await import(
  pathToFileURL(rspressShared.resolve('@rspress/shared/github-slugger')).href
)) as { default: new () => Slugger };
const { extractTextAndId } = (await import(
  pathToFileURL(rspressShared.resolve('@rspress/shared/node-utils')).href
)) as { extractTextAndId: (title: string) => [text: string, customId: string] };

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  depth?: number;
  children?: MdNode[];
  position?: { start: { line: number; column: number } };
};

export type DocLinkViolation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

type Page = { readonly file: string; readonly ids: ReadonlySet<string> };

type LinkSite = { readonly url: string; readonly line: number; readonly column: number };

function stripFrontmatter(source: string): { body: string; frontmatter: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { body: source, frontmatter: null };
  const blankLines = '\n'.repeat(match[0].split('\n').length - 1);
  return { body: blankLines + source.slice(match[0].length), frontmatter: match[1] ?? '' };
}

function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node);
  // Code blocks and inline code carry `value`, never children, so links inside them are not seen.
  for (const child of node.children ?? []) walk(child, visit);
}

function directText(node: MdNode): string {
  return (node.children ?? [])
    .filter((child) => child.type === 'text')
    .map((child) => child.value ?? '')
    .join('');
}

/** The [text, custom id] rspress's header-anchor plugin derives from a heading. */
function headingText(heading: MdNode): [string, string] {
  let text = '';
  let customId = '';
  for (const child of heading.children ?? []) {
    if (child.type === 'text') {
      const [textPart, idPart] = extractTextAndId(child.value ?? '');
      text += textPart;
      customId = idPart;
    } else if (child.type === 'inlineCode') {
      text += child.value ?? '';
    } else {
      text += directText(child);
    }
  }
  return [text, customId];
}

type ParsedPage = {
  readonly tree: MdNode;
  readonly frontmatter: string | null;
  readonly frontmatterSource: string;
};

function parsePage(source: string): ParsedPage {
  const { body, frontmatter } = stripFrontmatter(source);
  return { tree: fromMarkdown(body) as MdNode, frontmatter, frontmatterSource: source };
}

function headingIds(
  file: string,
  tree: MdNode,
  violations: DocLinkViolation[],
): ReadonlySet<string> {
  const slugger = new RspressSlugger();
  const ids = new Set<string>();
  const bases = new Map<string, number>();
  walk(tree, (node) => {
    if (node.type !== 'heading') return;
    const [text, customId] = headingText(node);
    const base = customId || new RspressSlugger().slug(text.trim());
    const line = node.position?.start.line ?? 0;
    const previous = bases.get(base);
    if (previous !== undefined) {
      violations.push({
        file,
        line,
        column: node.position?.start.column ?? 0,
        message: `heading ID "${base}" duplicates the heading on line ${previous}`,
      });
    } else {
      bases.set(base, line);
    }
    ids.add(customId || slugger.slug(text.trim()));
  });
  return ids;
}

function linkSites(tree: MdNode): LinkSite[] {
  const sites: LinkSite[] = [];
  walk(tree, (node) => {
    if ((node.type === 'link' || node.type === 'definition') && node.url) {
      sites.push({
        url: node.url,
        line: node.position?.start.line ?? 0,
        column: node.position?.start.column ?? 0,
      });
    }
  });
  return sites;
}

function collectLinkValues(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectLinkValues(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'link' && typeof item === 'string') into.push(item);
      else collectLinkValues(item, into);
    }
  }
}

function frontmatterLinkSites(page: ParsedPage): LinkSite[] {
  if (page.frontmatter === null) return [];
  const links: string[] = [];
  collectLinkValues(parseYaml(page.frontmatter), links);
  const lines = page.frontmatterSource.split('\n');
  return links.map((url) => {
    const index = lines.findIndex((line) => line.includes(url));
    return { url, line: index + 1, column: (lines[index]?.indexOf(url) ?? -1) + 1 };
  });
}

function listPages(root: string): string[] {
  const docsRoot = path.join(root, DOCS_DIR);
  return (fs.readdirSync(docsRoot, { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((entry) => !entry.startsWith('public/') && /\.mdx?$/.test(entry))
    .sort();
}

/** The site route a page file under website/docs renders at: `docs/sessions.md` → `/docs/sessions`. */
function routeOf(pagePath: string): string {
  const route = `/${pagePath.replace(/\.mdx?$/, '')}`;
  return route === '/index' ? '/' : route.replace(/\/index$/, '');
}

function normalizeRoute(route: string): string {
  const trimmed = route.replace(/\.(?:mdx?|html)$/, '').replace(/\/index$/, '');
  return trimmed.length > 1 ? trimmed.replace(/\/$/, '') : '/';
}

function splitFragment(url: string): { target: string; fragment: string | null } {
  const hash = url.indexOf('#');
  if (hash === -1) return { target: url.replace(/\?.*$/, ''), fragment: null };
  return { target: url.slice(0, hash).replace(/\?.*$/, ''), fragment: url.slice(hash + 1) };
}

/** The site path a link names, or null when it leaves the docs site. */
function sitePath(url: string, fromRoute: string | null): string | null {
  if (url.startsWith(PUBLISHED_ORIGIN)) return url.slice(PUBLISHED_ORIGIN.length) || '/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null;
  if (url.startsWith('/')) return url;
  if (fromRoute === null) return null;
  return path.posix.join(fromRoute === '/' ? '/' : path.posix.dirname(fromRoute), url);
}

/** The page route a link names, or null when it leaves the docs site or names an asset. */
function linkRoute(url: string, fromRoute: string | null): string | null {
  const target = sitePath(url, fromRoute);
  if (target === null) return null;
  const isAsset = /\.[a-z0-9]+$/i.test(target) && !/\.(?:mdx?|html)$/.test(target);
  return isAsset ? null : normalizeRoute(target);
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function checkSite(
  file: string,
  site: LinkSite,
  fromRoute: string | null,
  pages: ReadonlyMap<string, Page>,
): DocLinkViolation | null {
  const at = { file, line: site.line, column: site.column };
  const { target, fragment } = splitFragment(site.url);
  const route = target === '' ? fromRoute : linkRoute(target, fromRoute);
  if (route === null) return null;
  const page = pages.get(route);
  if (!page) return { ...at, message: `"${site.url}" names no docs page (route ${route})` };
  if (!fragment || page.ids.has(decodeFragment(fragment))) return null;
  return { ...at, message: `"${site.url}" names no heading on ${page.file}` };
}

type SourcePage = {
  readonly file: string;
  readonly route: string;
  readonly page: ParsedPage;
  readonly checked: boolean;
};

function readPages(root: string): SourcePage[] {
  return listPages(root).map((pagePath) => {
    const file = `${DOCS_DIR}/${pagePath}`;
    const page = parsePage(fs.readFileSync(path.join(root, file), 'utf8'));
    return { file, route: routeOf(pagePath), page, checked: pagePath.endsWith('.md') };
  });
}

function pageLinkViolations(
  sources: readonly SourcePage[],
  pages: ReadonlyMap<string, Page>,
): DocLinkViolation[] {
  return sources
    .filter((source) => source.checked)
    .flatMap(({ file, route, page }) =>
      [...frontmatterLinkSites(page), ...linkSites(page.tree)].map((site) =>
        checkSite(file, site, route, pages),
      ),
    )
    .filter((violation): violation is DocLinkViolation => violation !== null);
}

// README renders on GitHub and npm; only its links into the published docs site are ours.
function readmeViolations(root: string, pages: ReadonlyMap<string, Page>): DocLinkViolation[] {
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) return [];
  return linkSites(parsePage(fs.readFileSync(readme, 'utf8')).tree)
    .filter((site) => site.url.startsWith(`${PUBLISHED_ORIGIN}/`))
    .map((site) => checkSite('README.md', site, null, pages))
    .filter((violation): violation is DocLinkViolation => violation !== null);
}

export function checkDocLinks(root: string): DocLinkViolation[] {
  const violations: DocLinkViolation[] = [];
  const sources = readPages(root);
  const pages = new Map<string, Page>(
    sources.map(({ file, route, page }) => [
      route,
      { file, ids: headingIds(file, page.tree, violations) },
    ]),
  );
  return [...violations, ...pageLinkViolations(sources, pages), ...readmeViolations(root, pages)];
}

function main(): number {
  const violations = checkDocLinks(REPO_ROOT);
  if (violations.length === 0) {
    process.stdout.write('doc links: every internal link resolves.\n');
    return 0;
  }
  for (const violation of violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}:${violation.column}: ${violation.message}\n`,
    );
  }
  process.stderr.write(`doc links: ${violations.length} broken link(s) or heading ID(s).\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
