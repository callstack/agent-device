// Writes the redirect site that replaces the old docs at oss.callstack.com/agent-device (GitHub
// Pages, the gh-pages branch). GitHub Pages cannot send HTTP redirects, so every old page becomes
// a stub that points at the same path on agent-device.dev. deploy.yml publishes the output dir.
//
// - Home and docs pages (`docs/<page>.html`): a canonical link and an instant refresh, plus a
//   script that keeps the #fragment.
// - Docs Markdown (`docs/<page>.md`), llms.txt and llms-full.txt: copied from agent-device.dev,
//   so LLM clients that run no scripts still get the content. The script fails when the new site
//   does not serve them, so the old site stays published until agent-device.dev is live.
// - index.md: a short note with the new URLs.
// - Any other path: 404.html sends it to the same path on agent-device.dev.
// - Static assets (docs/public): copied, so pages that embed the old image URLs keep working.
// - website/vercel.json: turns off Vercel deployments of gh-pages. The Vercel project builds every
//   branch from its website/ root, and gh-pages has no site to build.
//
// Usage: node scripts/oss-redirects.mjs <output dir>
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { site } from '../src/site/content.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/oss-redirects.mjs <output dir>');

const OLD_BASE = '/agent-device';

const stub = (url) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Moved to ${site.url}</title>
    <link rel="canonical" href="${url}" />
    <meta http-equiv="refresh" content="0; url=${url}" />
    <script>location.replace(${JSON.stringify(url)} + location.hash);</script>
  </head>
  <body>
    <p>This page moved to <a href="${url}">${url}</a>.</p>
  </body>
</html>
`;

const notFound = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Moved to ${site.url}</title>
    <script>
      const path = location.pathname.replace(${JSON.stringify(OLD_BASE)}, '').replace(/\\.html$/, '');
      location.replace(${JSON.stringify(site.url)} + (path || '/') + location.search + location.hash);
    </script>
  </head>
  <body>
    <p>agent-device moved to <a href="${site.url}">${site.url}</a>.</p>
  </body>
</html>
`;

/** A text file from the live site; fails unless agent-device.dev serves it as text. */
async function live(path) {
  const url = `${site.url}/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !/^text\/(markdown|plain)/.test(type)) {
    throw new Error(`oss-redirects: ${url} is not live (HTTP ${response.status}, ${type}).`);
  }
  return response.text();
}

const pages = (await readdir(join(root, 'docs/docs')))
  .filter((file) => file.endsWith('.md') && !file.startsWith('_'))
  .map((file) => basename(file, '.md'));

const text = ['llms.txt', 'llms-full.txt', ...pages.map((page) => `docs/${page}.md`)];
const files = {
  '.nojekyll': '',
  'index.html': stub(`${site.url}/`),
  'index.md': `# Moved\n\nagent-device moved to ${site.url}. Its docs index for LLMs is ${site.url}/llms.txt\n`,
  '404.html': notFound,
  'website/vercel.json': `${JSON.stringify({ git: { deploymentEnabled: false } }, null, 2)}\n`,
  ...Object.fromEntries(
    pages.map((page) => [`docs/${page}.html`, stub(`${site.url}/docs/${page}`)]),
  ),
  ...Object.fromEntries(await Promise.all(text.map(async (path) => [path, await live(path)]))),
};

await rm(out, { recursive: true, force: true });
await cp(join(root, 'docs/public'), out, { recursive: true });
for (const [name, body] of Object.entries(files)) {
  await mkdir(dirname(join(out, name)), { recursive: true });
  await writeFile(join(out, name), body);
}
console.log(`oss-redirects: ${pages.length} docs pages → ${site.url} in ${out}`);
