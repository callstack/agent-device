import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import {
  assembleChangelog,
  parseFragment,
  readFragments,
  runCli,
  type ChangelogFragment,
} from '../changelog-release.ts';

const BASE_CHANGELOG = '# Changelog\n\n## 0.21.12\n\n- Fixed: an earlier release note. (#1)\n\n';

const FRAGMENTS: ChangelogFragment[] = [
  {
    name: 'z-fixed-fragment.md',
    text: '- Fixed: a `z`-named fragment bullet.\n  A continuation line.\n',
  },
  {
    name: 'a-breaking-fragment.md',
    text: '- Breaking: an `a`-named fragment bullet.\n',
  },
  {
    name: 'b-changed-fragment.md',
    text: '- Changed: first bullet in this fragment.\n- Changed: second bullet in this fragment.\n',
  },
];

test('determinism: two input orders give byte-identical output', () => {
  const forward = assembleChangelog({
    changelog: BASE_CHANGELOG,
    fragments: FRAGMENTS,
    version: '0.22.0',
  });
  const reversed = assembleChangelog({
    changelog: BASE_CHANGELOG,
    fragments: [...FRAGMENTS].reverse(),
    version: '0.22.0',
  });
  assert.equal(forward, reversed);

  // The expected output is a literal, not derived from the implementation: kind rank
  // (Breaking, Changed, Fixed) first, fragment name second, position in the fragment third.
  const expected =
    '# Changelog\n\n' +
    '## 0.22.0\n\n' +
    '- Breaking: an `a`-named fragment bullet.\n' +
    '- Changed: first bullet in this fragment.\n' +
    '- Changed: second bullet in this fragment.\n' +
    '- Fixed: a `z`-named fragment bullet.\n  A continuation line.\n\n' +
    '## 0.21.12\n\n- Fixed: an earlier release note. (#1)\n\n';
  assert.equal(forward, expected);
});

test('kind order: a Fixed fragment named a-… sorts after a Breaking fragment named z-…', () => {
  const result = assembleChangelog({
    changelog: BASE_CHANGELOG,
    fragments: [
      { name: 'a-fixed.md', text: '- Fixed: comes from the alphabetically-first fragment.\n' },
      { name: 'z-breaking.md', text: '- Breaking: comes from the alphabetically-last fragment.\n' },
    ],
    version: '0.22.0',
  });
  const breakingIndex = result.indexOf('- Breaking:');
  const fixedIndex = result.indexOf('- Fixed:');
  expect(breakingIndex).toBeGreaterThan(-1);
  expect(fixedIndex).toBeGreaterThan(breakingIndex);
});

test('refusal: a "-dev" version never becomes a heading', () => {
  expect(() =>
    assembleChangelog({ changelog: BASE_CHANGELOG, fragments: FRAGMENTS, version: '0.22.0-dev' }),
  ).toThrow(/-dev/);
});

test('refusal: CHANGELOG.md already contains the target version heading', () => {
  expect(() =>
    assembleChangelog({ changelog: BASE_CHANGELOG, fragments: FRAGMENTS, version: '0.21.12' }),
  ).toThrow(/already has a "## 0\.21\.12" section/);
});

test('refusal: CHANGELOG.md still contains an Unreleased heading', () => {
  const withUnreleased = '# Changelog\n\n## Unreleased\n\n- Fixed: pending.\n\n## 0.21.12\n\n';
  expect(() =>
    assembleChangelog({ changelog: withUnreleased, fragments: FRAGMENTS, version: '0.22.0' }),
  ).toThrow(/Unreleased/);
});

test('refusal: an invalid fragment throws and names the fragment', () => {
  const invalid: ChangelogFragment = { name: 'bad-fragment.md', text: 'not a bullet line\n' };
  expect(() =>
    assembleChangelog({ changelog: BASE_CHANGELOG, fragments: [invalid], version: '0.22.0' }),
  ).toThrow(/bad-fragment\.md/);
});

test('parseFragment: fragment name must match the slug pattern', () => {
  expect(() => parseFragment({ name: 'Not_A_Slug.md', text: '- Fixed: x.\n' })).toThrow(
    /must match/,
  );
});

test('parseFragment: an unindented continuation line fails validation', () => {
  expect(() => parseFragment({ name: 'ok.md', text: '- Fixed: x.\nnot indented\n' })).toThrow(
    /invalid line/,
  );
});

test('parseFragment: a leading non-bullet line fails validation', () => {
  expect(() => parseFragment({ name: 'ok.md', text: 'not a bullet\n- Fixed: x.\n' })).toThrow(
    /invalid line/,
  );
});

test('parseFragment: an unknown kind is rejected as an invalid line', () => {
  expect(() =>
    parseFragment({ name: 'ok.md', text: '- Info: not one of the allowed kinds.\n' }),
  ).toThrow(/invalid line/);
});

test('parseFragment: a leading indented line has no bullet to attach to and fails validation', () => {
  // The line matches the continuation pattern, but `current` is still undefined at this point,
  // so the `current &&` guard must not let it through as a continuation.
  expect(() =>
    parseFragment({ name: 'ok.md', text: '  indented before any bullet\n- Fixed: x.\n' }),
  ).toThrow(/invalid line/);
});

test('no fragments: the input comes back unchanged, even with an unmigrated Unreleased heading', () => {
  const withUnreleased = '# Changelog\n\n## Unreleased\n\n- Fixed: pending.\n\n## 0.21.12\n\n';
  assert.equal(
    assembleChangelog({ changelog: withUnreleased, fragments: [], version: '0.22.0-dev' }),
    withUnreleased,
  );
});

function scratchRepo(): string {
  const root = mkdtempForTestSync('agent-device-changelog-release-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.22.0' }));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), BASE_CHANGELOG);
  const fragmentsDir = path.join(root, 'changelog.d');
  fs.mkdirSync(fragmentsDir, { recursive: true });
  fs.writeFileSync(path.join(fragmentsDir, 'README.md'), '# changelog.d\n');
  fs.writeFileSync(
    path.join(fragmentsDir, '2799-example.md'),
    '- Fixed: a scratch-repo fragment.\n',
  );
  return root;
}

test('CLI default mode writes the assembled section and deletes consumed fragments', () => {
  const root = scratchRepo();
  const exitCode = runCli({ root, check: false });
  assert.equal(exitCode, 0);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## 0\.22\.0\n\n- Fixed: a scratch-repo fragment\./);
  assert.deepEqual(fs.readdirSync(path.join(root, 'changelog.d')), ['README.md']);
});

test('CLI --check exits 1 while a fragment remains and 0 once only README.md is left', () => {
  const root = scratchRepo();
  assert.equal(runCli({ root, check: true }), 1);
  assert.equal(runCli({ root, check: false }), 0);
  assert.equal(runCli({ root, check: true }), 0);
});

test('CLI double-run: assembling into an already-released version heading throws', () => {
  const root = scratchRepo();
  assert.equal(runCli({ root, check: false }), 0);

  // Simulate a second commit landing before the next version bump: a new fragment arrives, but
  // package.json's version is unchanged, so the "## 0.22.0" heading already exists.
  fs.writeFileSync(
    path.join(root, 'changelog.d', '9999-second.md'),
    '- Fixed: a second, unconsumed fragment.\n',
  );
  expect(() => runCli({ root, check: false })).toThrow(/already has a "## 0\.22\.0" section/);
});

test('CLI refusal leaves CHANGELOG.md and the pending fragment untouched on disk', () => {
  const root = scratchRepo();
  assert.equal(runCli({ root, check: false }), 0);

  const fragmentPath = path.join(root, 'changelog.d', '9999-second.md');
  const fragmentText = '- Fixed: a second, unconsumed fragment.\n';
  fs.writeFileSync(fragmentPath, fragmentText);
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changelogBefore = fs.readFileSync(changelogPath, 'utf8');

  expect(() => runCli({ root, check: false })).toThrow();

  assert.equal(fs.readFileSync(changelogPath, 'utf8'), changelogBefore);
  assert.equal(fs.readFileSync(fragmentPath, 'utf8'), fragmentText);
});

test('CLI: a fragment without the .md extension is rejected, not silently skipped', () => {
  const root = scratchRepo();
  fs.writeFileSync(path.join(root, 'changelog.d', '9999-no-extension'), '- Fixed: x.\n');

  // The same enumeration (`readFragments`) feeds both --check and the default run, so a
  // wrongly-named entry fails loudly in either mode instead of being filtered out by one of them.
  expect(() => runCli({ root, check: true })).toThrow(/must end in "\.md"/);
  expect(() => runCli({ root, check: false })).toThrow(/must end in "\.md"/);
});

test('CLI: a dotfile in changelog.d is neither a fragment nor a refusal', () => {
  const root = scratchRepo();
  fs.writeFileSync(path.join(root, 'changelog.d', '.DS_Store'), '\u0000\u0001binary');

  assert.equal(runCli({ root, check: false }), 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'changelog.d')).sort(), [
    '.DS_Store',
    'README.md',
  ]);
  assert.equal(runCli({ root, check: true }), 0);
});

// Repository guard: every fragment `readFragments` would actually consume (other than README.md)
// must have a valid name and pass parseFragment, so a malformed or wrongly-named fragment is
// caught before it ships instead of being silently skipped by a stricter enumeration.
test('every real changelog.d fragment has a valid name and passes parseFragment', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const fragmentsDir = path.join(repoRoot, 'changelog.d');
  for (const fragment of readFragments(fragmentsDir)) {
    parseFragment(fragment);
  }
});

// Repository guard: the real CHANGELOG.md carries no "## Unreleased" heading, so the assembler's
// refusal never fires on the first real release that ships a fragment.
test('the real CHANGELOG.md has no "## Unreleased" heading', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  assert.equal(changelog.includes('## Unreleased'), false);
});

const MIGRATED_HEADING = '## 0.15.1 – 0.21.13';
const MIGRATED_TAG = 'v0.21.13';

/**
 * The bullets under `heading`: every line from the first line starting with `- ` up to (not
 * including) the next `## ` heading, with trailing blank lines trimmed. Skips any prose between
 * the heading and its first bullet (for example the migrated section's one-line note), so the
 * comparison is bullet content only, not the surrounding heading text.
 */
function sectionBullets(changelog: string, heading: string): string[] {
  const lines = changelog.split('\n');
  const headingIndex = lines.indexOf(heading);
  assert.notEqual(headingIndex, -1, `expected to find a "${heading}" heading`);
  let start = headingIndex + 1;
  while (start < lines.length && !lines[start].startsWith('- ')) start++;
  let end = start;
  while (end < lines.length && !lines[end].startsWith('## ')) end++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end);
}

// Repository guard: a rebase onto a newer base can replay the "## Unreleased" -> historical-range
// heading rename over a CHANGELOG.md that has grown new bullets since the tag, silently folding
// them into a released section they never shipped in (the "no Unreleased heading" guard above
// passes either way, since the heading is gone in both the correct and the stale case). Pin the
// migrated section's bullets to be byte-identical to the tag's own "## Unreleased" bullets, so a
// stale-base migration -- one that carries bullets the tag never had -- fails loudly instead of
// merging clean.
test(`the "${MIGRATED_HEADING}" section is byte-identical to ${MIGRATED_TAG}'s Unreleased block`, () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  if (!changelog.includes(`${MIGRATED_HEADING}\n`)) {
    // A later migration renamed or removed this section; nothing left here to pin against the tag.
    return;
  }

  let tagChangelog: string;
  try {
    tagChangelog = execFileSync('git', ['show', `${MIGRATED_TAG}:CHANGELOG.md`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(
      `This guard needs the "${MIGRATED_TAG}" tag (git show ${MIGRATED_TAG}:CHANGELOG.md failed: ` +
        `${stderr}). Fetch tags from origin; the gate does not skip.`,
      { cause: error },
    );
  }

  assert.deepEqual(
    sectionBullets(changelog, MIGRATED_HEADING),
    sectionBullets(tagChangelog, '## Unreleased'),
  );
});
