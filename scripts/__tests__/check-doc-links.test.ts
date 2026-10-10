import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDocLinks } from '../check-doc-links.ts';

const SESSIONS = `---
title: Sessions
---

# Sessions

## Find a session's logs and artifacts

## Structured node fields (\`--json\`)

## Pinned anchor {#pinned}

## **Bold** and [linked](https://example.com) text
`;

function plant(files: Record<string, string>): string[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-links-'));
  const tree = { 'website/docs/docs/sessions.md': SESSIONS, ...files };
  for (const [name, body] of Object.entries(tree)) {
    fs.mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return checkDocLinks(root).map(
    (violation) => `${violation.file}:${violation.line} ${violation.message}`,
  );
}

function page(body: string): Record<string, string> {
  return { 'website/docs/docs/guide.md': `# Guide\n\n${body}\n` };
}

test('headings resolve to the IDs rspress renders', () => {
  assert.deepEqual(
    plant(
      page(
        [
          '[logs](/docs/sessions#find-a-sessions-logs-and-artifacts)',
          '[json](/docs/sessions#structured-node-fields---json)',
          '[pinned](/docs/sessions#pinned)',
          '[bold](/docs/sessions#bold-and-linked-text)',
        ].join('\n\n'),
      ),
    ),
    [],
  );
});

test('a link to a missing page fails', () => {
  assert.deepEqual(plant(page('[gone](/docs/missing)')), [
    'website/docs/docs/guide.md:3 "/docs/missing" names no docs page (route /docs/missing)',
  ]);
});

test('a link to a missing heading fails, across pages and on the same page', () => {
  assert.deepEqual(plant(page('[a](/docs/sessions#nope)\n\n[b](#also-nope)\n\n[c](#guide)')), [
    'website/docs/docs/guide.md:3 "/docs/sessions#nope" names no heading on website/docs/docs/sessions.md',
    'website/docs/docs/guide.md:5 "#also-nope" names no heading on website/docs/docs/guide.md',
  ]);
});

test('relative Markdown links and published-site URLs resolve to the same pages', () => {
  assert.deepEqual(
    plant(
      page(
        [
          '[rel](./sessions.md#pinned)',
          '[bare](sessions)',
          '[site](https://oss.callstack.com/agent-device/docs/sessions#pinned)',
          '[rel-bad](./session.md)',
        ].join('\n\n'),
      ),
    ),
    ['website/docs/docs/guide.md:9 "./session.md" names no docs page (route /docs/session)'],
  );
});

test('reference-style link definitions are checked', () => {
  assert.deepEqual(
    plant(
      page(
        'See [the sessions page][s] and [missing][m].\n\n[s]: /docs/sessions#pinned\n[m]: /docs/nowhere#x',
      ),
    ),
    ['website/docs/docs/guide.md:6 "/docs/nowhere#x" names no docs page (route /docs/nowhere)'],
  );
});

test('duplicate heading IDs on one page fail', () => {
  assert.deepEqual(plant(page('## Notes\n\n## Notes\n\n## Custom {#notes}')), [
    'website/docs/docs/guide.md:5 heading ID "notes" duplicates the heading on line 3',
    'website/docs/docs/guide.md:7 heading ID "notes" duplicates the heading on line 3',
  ]);
});

test('code blocks, inline code, and external URLs are not checked', () => {
  assert.deepEqual(
    plant(
      page(
        [
          '```md\n[gone](/docs/missing)\n```',
          'Inline `[gone](/docs/missing)` code.',
          '[external](https://example.com/docs/missing#x)',
          '[mail](mailto:hello@example.com)',
          '[asset](/logo.svg)',
        ].join('\n\n'),
      ),
    ),
    [],
  );
});

test('README is checked only for links into the published docs site', () => {
  assert.deepEqual(
    plant({
      'README.md': [
        '[ok](https://oss.callstack.com/agent-device/docs/sessions#pinned)',
        '[bad](https://oss.callstack.com/agent-device/docs/sessions#gone)',
        '[repo file](CONTRIBUTING.md)',
        '[github anchor](#not-a-docs-heading)',
      ].join('\n\n'),
    }),
    [
      'README.md:3 "https://oss.callstack.com/agent-device/docs/sessions#gone" names no heading on website/docs/docs/sessions.md',
    ],
  );
});

test('home page frontmatter links are checked', () => {
  assert.deepEqual(
    plant({
      'website/docs/index.md': [
        '---',
        'pageType: home',
        'hero:',
        '  actions:',
        '    - text: Start',
        '      link: /docs/sessions',
        '    - text: Gone',
        '      link: /docs/retired',
        '---',
        '',
      ].join('\n'),
    }),
    ['website/docs/index.md:8 "/docs/retired" names no docs page (route /docs/retired)'],
  );
});
