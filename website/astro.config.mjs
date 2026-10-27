// @ts-check
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

import { brandCss } from './src/site/brand.ts';
import { site as meta, noindexPaths } from './src/site/content.ts';
import { TITLE_DELIMITER } from './src/site/meta.ts';
import { llmsDescription, llmsDetails, llmsOptionalLinks } from './src/site/llms.ts';

const site = meta.url;
const repo = meta.repo;
const description = meta.description;
// Where this site lives inside the repo, for the docs' "Edit page" links.
const siteDir = 'website';

const doc = (name, label) => ({ label, slug: `docs/${name}` });
const group = (label, items) => ({ label, items: items.map(([name, text]) => doc(name, text)) });

export default defineConfig({
  site,
  // The README and tests link to files here by path (banner, demo GIF and video, logo).
  publicDir: './docs/public',
  // Pages are files (`docs/introduction.html`, `404.html`) served without `.html` or a trailing
  // slash (`cleanUrls` and `trailingSlash: false` in vercel.json).
  trailingSlash: 'never',
  build: { format: 'file' },
  // Responsive images: Markdown screenshots get a srcset, so phones don't download huge files.
  image: { layout: 'constrained' },
  devToolbar: { enabled: false },
  integrations: [
    // Starlight would add the sitemap itself; listed so the pages outside Starlight are included
    // and the noindex ones are left out.
    sitemap({
      filter: (page) => !noindexPaths.includes(new URL(page).pathname.replace(/\.html$/, '')),
    }),
    starlight({
      // Docs titles read "Page | Name", the pattern src/site/meta.ts builds for every page.
      title: meta.name,
      titleDelimiter: TITLE_DELIMITER,
      description,
      favicon: '/favicon.svg',
      // src/pages/404.astro replaces Starlight's 404, in the site's look.
      disable404Route: true,
      // Clean canonicals, per-page descriptions and breadcrumbs for docs pages.
      routeMiddleware: './src/routeData.ts',
      // The same tokens, fonts and lockup as the landing pages.
      customCss: ['./src/fonts/font-face.css', './src/styles/theme.css', './src/styles/docs.css'],
      components: {
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
        SiteTitle: './src/components/starlight/SiteTitle.astro',
        SocialIcons: './src/components/starlight/SocialIcons.astro',
        Footer: './src/components/starlight/Footer.astro',
      },
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/${siteDir}/src/content/docs/` },
      head: [
        // The accent as CSS variables (src/site/brand.ts), read by theme.css and docs.css.
        { tag: 'style', content: brandCss },
        // Starlight sets og:title, og:description and a large Twitter card, but no image.
        { tag: 'meta', attrs: { property: 'og:image', content: `${site}/og-image.jpg` } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: meta.ogAlt } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${site}/og-image.jpg` } },
        { tag: 'meta', attrs: { name: 'twitter:image:alt', content: meta.ogAlt } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0a0a0a' } },
        {
          tag: 'link',
          attrs: { rel: 'icon', href: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
        },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        {
          tag: 'link',
          attrs: { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: '/llms.txt' },
        },
      ],
      sidebar: [
        group('Getting started', [
          ['introduction', 'Introduction'],
          ['installation', 'Installation'],
          ['plugins', 'Provider plugins'],
          ['agent-setup', 'AI agent setup'],
          ['quick-start', 'Quick start'],
        ]),
        group('Using agent-device', [
          ['capabilities', 'Capabilities'],
          ['commands', 'Commands'],
          ['configuration', 'Configuration'],
          ['selectors', 'Selectors'],
          ['sessions', 'Sessions'],
          ['batching', 'Batching'],
          ['snapshots', 'Snapshots'],
          ['replay-e2e', 'Replay and E2E testing'],
          ['run-maestro-flows', 'Run Maestro flows'],
          ['debugging-profiling', 'Debugging and profiling'],
        ]),
        group('Integrations', [
          ['client-api', 'Node.js API'],
          ['build-an-integration', 'Build an integration'],
          ['ai-sdk', 'AI SDK'],
          ['eve', 'Eve'],
          ['remote-proxy', 'Remote proxy'],
          ['device-clouds', 'Device clouds'],
          ['browserstack', 'BrowserStack'],
          ['aws-device-farm', 'AWS Device Farm'],
          ['testmu', 'TestMu AI'],
          ['limrun', 'Limrun'],
        ]),
        group('Reference', [
          ['security-trust', 'Security and trust'],
          ['known-limitations', 'Known limitations'],
          ['migrating-gestures', 'Rewrite old gesture commands'],
        ]),
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: meta.name,
          description: llmsDescription,
          details: llmsDetails,
          optionalLinks: llmsOptionalLinks,
        }),
      ],
    }),
  ],
});
