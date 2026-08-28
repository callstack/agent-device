import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatSnapshotLine } from '../../snapshot/snapshot-lines.ts';

const mergedCard = {
  ref: 'e72',
  index: 0,
  depth: 0,
  type: 'Link',
  label: 'feedItem-by-whiskers.test',
  enabled: true,
};

test('formatSnapshotLine names the custom actions a merged element hides', () => {
  const line = formatSnapshotLine(
    { ...mergedCard, actions: ['Reply', 'Repost', 'Open post options menu'] },
    0,
    false,
    undefined,
    { summarizeTextSurfaces: true },
  );

  assert.equal(
    line,
    '@e72 [link] "feedItem-by-whiskers.test" actions: ["Reply", "Repost", "Open post options menu"]',
  );
});

test('formatSnapshotLine keeps actions after bracketed metadata', () => {
  const line = formatSnapshotLine(
    { ...mergedCard, enabled: false, actions: ['Reply'] },
    0,
    false,
    undefined,
    { summarizeTextSurfaces: true },
  );

  assert.equal(line, '@e72 [link] "feedItem-by-whiskers.test" [disabled] actions: ["Reply"]');
});

test('formatSnapshotLine omits the actions list when there is nothing to name', () => {
  for (const actions of [undefined, [], ['', '   ']]) {
    const line = formatSnapshotLine({ ...mergedCard, actions }, 0, false, undefined, {
      summarizeTextSurfaces: true,
    });
    assert.equal(line, '@e72 [link] "feedItem-by-whiskers.test"');
  }
});

test('formatSnapshotLine escapes app-authored names so they cannot corrupt the line', () => {
  const line = formatSnapshotLine(
    {
      ...mergedCard,
      actions: ['Say "hi"', String.raw`C:\path`, 'Reply\nto post', 'Bell\u0007ring'],
    },
    0,
    false,
    undefined,
    { summarizeTextSurfaces: true },
  );

  // Quotes and backslashes escape; a newline folds to a space; a bare control
  // character is dropped. The result stays exactly one line.
  assert.equal(
    line,
    String.raw`@e72 [link] "feedItem-by-whiskers.test" actions: ["Say \"hi\"", "C:\\path", "Reply to post", "Bellring"]`,
  );
  assert.equal(line.includes('\n'), false);
});

test('formatSnapshotLine still names actions on a hidden group, which has no label part', () => {
  const line = formatSnapshotLine({ ...mergedCard, actions: ['Reply'] }, 1, true, undefined, {
    summarizeTextSurfaces: true,
  });

  assert.equal(line, '  @e72 [link] actions: ["Reply"]');
});
