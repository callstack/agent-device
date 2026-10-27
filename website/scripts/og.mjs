// Renders og/og.html twice, as the social card (docs/public/og-image.jpg, 1200x630) and the README
// banner (docs/public/banner.jpg, 1660x512), and writes the icons (docs/public/favicon.svg,
// favicon-32.png, apple-touch-icon.png) from the mark. Run `pnpm og` after changing
// src/site/content.ts, src/site/brand.ts, og/og.html or the signature scene.
//
// The card never repeats a fact: this script imports content.ts and brand.ts (Node strips
// their types) and serves them to the page as /og/site.json and /og/brand.css. The dither
// module is served the same way, as /og/dither.js.
//
// Uses playwright-core's Chromium if installed (`pnpm exec playwright-core install chromium`),
// otherwise a local Google Chrome.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import sharp from 'sharp';

import { accent, accentRgb, brandCss } from '../src/site/brand.ts';
import { jobs, site } from '../src/site/content.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

// What the card shows, all from content.ts and brand.ts.
const card = {
  name: site.name,
  wordmark: site.wordmark,
  headline: site.headline,
  install: site.install,
  platforms: site.platforms,
  mark: site.mark ?? [],
  transcript: jobs[1].transcript,
  rgb: accentRgb.split(' ').map(Number),
};

// A static server over the website folder, plus the three generated files above.
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/og/dither.js') {
      const source = await readFile(join(root, 'src/components/site/dither.ts'), 'utf8');
      res.writeHead(200, { 'Content-Type': types['.js'] });
      res.end(stripTypeScriptTypes(source));
      return;
    }
    if (path === '/og/site.json') {
      res.writeHead(200, { 'Content-Type': types['.json'] });
      res.end(JSON.stringify(card));
      return;
    }
    if (path === '/og/brand.css') {
      res.writeHead(200, { 'Content-Type': types['.css'] });
      res.end(brandCss);
      return;
    }
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

await mkdir(join(root, 'docs/public'), { recursive: true });
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
try {
  const shots = [
    { query: '', width: 1200, height: 630, scale: 1, path: 'docs/public/og-image.jpg' },
    // 1245x384 at 4/3 gives the banner's 1660x512.
    {
      query: '?format=banner',
      width: 1245,
      height: 384,
      scale: 4 / 3,
      path: 'docs/public/banner.jpg',
    },
  ];
  for (const { query, width, height, scale, path } of shots) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    page.on('pageerror', (error) => console.error(error));
    await page.goto(`http://127.0.0.1:${port}/og/og.html${query}`);
    await page.waitForFunction(() => /** @type {any} */ (window).ogReady === true);
    const png = await page.screenshot({ type: 'png' });
    await writeFile(
      join(root, path),
      await sharp(png).jpeg({ quality: 90, mozjpeg: true }).toBuffer(),
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

// ---------- Icons ----------
// The mark in the accent, each step a whole number of pixels. Without a mark, the wordmark's
// first letter in dark on an accent block.
const BG = '#0a0a0a';
const mark = site.mark ?? [];
const markW = Math.max(0, ...mark.map((r) => r.length));
const markH = mark.length;

/** An SVG `size` px square: the mark centred on whole-pixel steps, `pad` px clear around it. */
function icon(size, pad, background) {
  const fill = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : '';
  if (!markH) {
    const letter = [...site.wordmark.toUpperCase()][0] ?? '';
    const box = size - pad * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${fill}<rect x="${pad}" y="${pad}" width="${box}" height="${box}" fill="${accent}"/><text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${Math.round(box * 0.72 * 100) / 100}" fill="${BG}">${letter}</text></svg>`;
  }
  const step = Math.max(1, Math.floor((size - pad * 2) / Math.max(markW, markH)));
  const x0 = Math.floor((size - step * markW) / 2);
  const y0 = Math.floor((size - step * markH) / 2);
  const rects = mark
    .flatMap((row, y) =>
      [...row].map((c, x) =>
        c === '#'
          ? `<rect x="${x0 + x * step}" y="${y0 + y * step}" width="${step}" height="${step}"/>`
          : '',
      ),
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">${fill}<g fill="${accent}">${rects}</g></svg>`;
}

// The SVG favicon scales, so any whole step size does; 10px steps keep the numbers readable.
const side = Math.max(markW, markH, 1) * 10;
await writeFile(join(root, 'docs/public/favicon.svg'), icon(side, 0, ''));
for (const [name, size, pad, background] of [
  ['favicon-32.png', 32, 0, ''],
  ['apple-touch-icon.png', 180, 36, BG],
]) {
  await writeFile(
    join(root, 'docs/public', name),
    await sharp(Buffer.from(icon(size, pad, background)))
      .png()
      .toBuffer(),
  );
}
console.log('Wrote docs/public/og-image.jpg, banner.jpg, favicon.svg and the PNG icons');
