import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDocProse, PROSE_RULES } from '../check-doc-prose.ts';

function hits(text: string): string[] {
  return checkDocProse('page.md', text).map(
    ({ line, column, word }) => `${line}:${column} ${word}`,
  );
}

test('banned words match case-insensitively as whole words, with line and column', () => {
  assert.deepEqual(hits('Simply run it.\nIt is Just fine, and EASY.'), [
    '1:1 simply',
    '2:7 just',
    '2:22 easy',
  ]);
  assert.deepEqual(hits('Justify the adjustment; robustness and uneasy are fine.'), []);
});

test('phrases match across any run of whitespace', () => {
  assert.deepEqual(hits('Support is coming  soon. As of now it is newly added.'), [
    '1:12 coming soon',
    '1:26 as of now',
    '1:42 newly added',
  ]);
});

test('bare new, now, and current are allowed', () => {
  assert.deepEqual(hits('The new session is now the current one.'), []);
});

test('each violation names the file, position, matched text, and reason', () => {
  const [violation] = checkDocProse('README.md', 'It is robust.');
  assert.equal(
    violation?.message,
    'README.md:1:7: "robust" — marketing adjective: state what the feature does instead',
  );
});

test('every rule is a lowercase word or phrase with a reason', () => {
  for (const { word, reason } of PROSE_RULES) {
    assert.match(word, /^[a-z]+(?: [a-z]+)*$/);
    assert.ok(reason.length > 0, word);
  }
});

test('YAML frontmatter at the top is skipped, but a later thematic break is prose', () => {
  assert.deepEqual(hits('---\ntitle: Just a page\n---\nText.\n\n---\n\nSimply.'), ['8:1 simply']);
});

test('fenced code is skipped until a matching closer of at least the opening length', () => {
  const text = [
    '````md',
    'just',
    '```',
    'still code: simply',
    '````',
    '~~~',
    'easy',
    '~~~~',
    'Prose: obviously.',
  ].join('\n');
  assert.deepEqual(hits(text), ['9:8 obviously']);
});

test('a backtick fence is not closed by tildes', () => {
  assert.deepEqual(hits('```\n~~~\njust\n```\nJust.'), ['5:1 just']);
});

test('a fence inside a blockquote is skipped through its quoted closer', () => {
  assert.deepEqual(hits('> ```sh\n> just build\n> ```\n> Simply.'), ['4:3 simply']);
});

test('a fence inside an HTML comment does not swallow the prose after the comment', () => {
  assert.deepEqual(hits('<!--\n```\n-->\nJust.'), ['4:1 just']);
});

test('inline code spans are skipped, matching backtick run lengths', () => {
  assert.deepEqual(hits('Run `just build` or ``a ` just`` then just go.'), ['1:39 just']);
});

test('an inline code span that wraps across lines is skipped', () => {
  assert.deepEqual(hits('Run `just\nsimply` here.'), []);
});

test('a stray backtick does not mask past the end of its paragraph', () => {
  assert.deepEqual(hits('A ` tick.\n\nJust `x`.'), ['3:1 just']);
});

test('a phrase wrapped across lines matches at its first word', () => {
  assert.deepEqual(hits('Support is coming\nsoon.'), ['1:12 coming soon']);
});

test('HTML tags, comments, link destinations, and bare URLs are skipped', () => {
  const text = [
    '<Tab label="easy">Easy</Tab>',
    'See [the guide](./just-start.md) and ![logo](robust.svg).',
    'Visit https://example.com/simply/easy now.',
    'Before <!-- just a note --> after.',
    '<!-- spans',
    'simply',
    'lines --> robust',
  ].join('\n');
  assert.deepEqual(hits(text), ['1:19 easy', '7:11 robust']);
});

test('link text is prose', () => {
  assert.deepEqual(hits('[Simply start](./start.md)'), ['1:2 simply']);
});

test('CRLF line endings are scanned like LF', () => {
  const text = ['---', 'title: Simply the best', '---', '', 'You just run it.', ''].join('\r\n');
  assert.deepEqual(
    checkDocProse('page.md', text).map(({ line, word }) => `${line}:${word}`),
    ['5:just'],
  );
});
