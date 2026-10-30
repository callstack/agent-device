// @ts-check
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

import { brandCss } from './src/site/brand.ts';
import { site as meta, noindexPaths } from './src/site/content.ts';
import { TITLE_DELIMITER } from './src/site/meta.ts';
import {
  llmsDescription,
  llmsDetails,
  llmsOptionalLinks,
  llmsSmallExclude,
} from './src/site/llms.ts';

const site = meta.url;
const repo = meta.repo;
const description = meta.description;
// Where this site lives inside the repo, for the docs' "Edit page" links.
const siteDir = 'website';

// Sidebar entries take the page's own title, so a page has one name everywhere.
const group = (label, names) => ({ label, items: names.map((name) => `docs/${name}`) });

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
        Head: './src/components/starlight/Head.astro',
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
        SiteTitle: './src/components/starlight/SiteTitle.astro',
        SocialIcons: './src/components/starlight/SocialIcons.astro',
        Footer: './src/components/starlight/Footer.astro',
      },
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/${siteDir}/` },
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
          'introduction',
          'installation',
          'plugins',
          'agent-setup',
          'quick-start',
        ]),
        group('Usage', [
          'capabilities',
          'commands',
          'configuration',
          'selectors',
          'sessions',
          'batching',
          'snapshots',
          'replay-e2e',
          'run-maestro-flows',
          'debugging-profiling',
        ]),
        group('Integrations', [
          'client-api',
          'build-an-integration',
          'ai-sdk',
          'eve',
          'remote-proxy',
          'device-clouds',
          'browserstack',
          'aws-device-farm',
          'testmu',
          'limrun',
        ]),
        {
          label: 'Reference',
          items: [
            'docs/security-trust',
            'docs/known-limitations',
            'docs/migrating-gestures',
            { label: 'Dependency graph', link: '/depgraph/' },
          ],
        },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: meta.name,
          description: llmsDescription,
          details: llmsDetails,
          optionalLinks: llmsOptionalLinks,
          // llms-small.txt leaves out the reference pages in llmsSmallExclude (their tables also
          // flatten badly there); llms-full.txt keeps every page.
          exclude: llmsSmallExclude.map((slug) => `docs/${slug}`),
        }),
      ],
    }),
  ],
});
