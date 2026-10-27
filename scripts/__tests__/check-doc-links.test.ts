import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDocLinks } from '../check-doc-links.ts';

const BASE = '/agent-device/';

const SESSIONS = [
  '<h1 id="sessions">Sessions</h1>',
  '<h2 id="find-a-sessions-logs-and-artifacts">Find a session&#x27;s logs and artifacts</h2>',
  '<img id="logo" src="/agent-device/logo-light.svg"/><img id="logo" src="/agent-device/logo-dark.svg"/>',
].join('\n');

function plant(pages: Record<string, string>, readme = ''): string[] {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-build-'));
  const tree = {
    'index.html': '<a href="/agent-device/">home</a>',
    'docs/sessions.html': SESSIONS,
    'logo.svg': '<svg/>',
    ...pages,
  };
  for (const [name, body] of Object.entries(tree)) {
    fs.mkdirSync(path.join(buildDir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(buildDir, name), body);
  }
  return checkDocLinks(buildDir, readme, BASE).map(({ where, message }) => `${where}: ${message}`);
}

function guide(body: string): Record<string, string> {
  return { 'docs/guide.html': `<h1 id="guide">Guide</h1>\n${body}` };
}

test('links to rendered pages and IDs pass', () => {
  assert.deepEqual(
    plant(
      guide(
        [
          '<a href="/agent-device/docs/sessions">page</a>',
          '<a href="/agent-device/docs/sessions#find-a-sessions-logs-and-artifacts">heading</a>',
          '<a href="/agent-device/docs/sessions.html#sessions">html suffix</a>',
          '<a href="/agent-device/">home</a>',
          '<a href="#guide">same page</a>',
        ].join('\n'),
      ),
    ),
    [],
  );
});

test('a link to a page that was not built fails', () => {
  assert.deepEqual(plant(guide('<a href="/agent-device/docs/missing">x</a>')), [
    'docs/guide: link "/agent-device/docs/missing" → no such page',
  ]);
});

test('a link to an ID the target page does not render fails', () => {
  assert.deepEqual(
    plant(guide('<a href="/agent-device/docs/sessions#find-a-session-logs">x</a>')),
    [
      'docs/guide: link "/agent-device/docs/sessions#find-a-session-logs" → no heading "find-a-session-logs"',
    ],
  );
});

test('a same-page fragment must name an ID on that page', () => {
  assert.deepEqual(plant(guide('<a href="#guide">ok</a><a href="#nope">x</a>')), [
    'docs/guide: link "#nope" → no heading "nope"',
  ]);
});

test('a heading ID rendered twice on one page fails; repeated non-heading IDs do not', () => {
  assert.deepEqual(plant(guide('<h2 id="notes">Notes</h2>\n<h2 id="notes">Pinned</h2>')), [
    'docs/guide: heading ID "notes" is rendered twice',
  ]);
});

test('external URLs are skipped and asset links must exist', () => {
  assert.deepEqual(
    plant(
      guide(
        [
          '<a href="https://example.com/agent-device/docs/missing#x">external</a>',
          '<a href="mailto:hello@example.com">mail</a>',
          '<a href="https://github.com/callstack/agent-device?a=1&amp;b=2">query</a>',
          '<link href="/agent-device/logo.svg">',
          '<link href="/agent-device/gone.svg">',
        ].join('\n'),
      ),
    ),
    ['docs/guide: link "/agent-device/gone.svg" → no such page'],
  );
});

test('README links into the published docs are checked against the built pages', () => {
  const readme = [
    'Read [sessions](https://agent-device.dev/docs/sessions#find-a-sessions-logs-and-artifacts).',
    'Bare: https://agent-device.dev/docs/sessions#gone',
    '[Missing](https://agent-device.dev/docs/retired) and [repo](CONTRIBUTING.md).',
    'Elsewhere: https://agent-device.dev-old/docs/retired',
    'End of sentence: https://agent-device.dev/docs/sessions.',
  ].join('\n');
  assert.deepEqual(plant({}, readme), [
    'README.md:2: link "https://agent-device.dev/docs/sessions#gone" → no heading "gone"',
    'README.md:3: link "https://agent-device.dev/docs/retired" → no such page',
  ]);
});
