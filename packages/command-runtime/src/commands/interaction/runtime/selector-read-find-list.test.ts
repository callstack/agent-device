import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError, readElementMatchCandidateRefs } from '@agent-device/kernel/errors';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createSelectorDevice } from './__tests__/test-utils/index.ts';

const APPLICATION = {
  index: 0,
  type: 'Application',
  rect: { x: 0, y: 0, width: 800, height: 1200 },
};

const followButton = (index: number, x: number) => ({
  index,
  parentIndex: 0,
  type: 'Button',
  label: 'Follow',
  hittable: true,
  rect: { x, y: 100, width: 80, height: 40 },
});

// #1625 decision 1: `find <q> list` is the read-only inspection surface the ambiguity recovery
// hint points at. The test device's backend has no touch member, so a list that acted would throw.
test('runtime find list returns every matching node with its ref', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([APPLICATION, followButton(1, 0), followButton(2, 90), followButton(3, 180)]),
  );

  const listed = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Follow',
    action: 'list',
  });

  assert.equal(listed.kind, 'list');
  assert.deepEqual(
    listed.matches.map((entry) => entry.ref),
    ['@e2', '@e3', '@e4'],
  );
});

test('runtime find list on a unique match still lists instead of acting', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([
      APPLICATION,
      {
        index: 1,
        parentIndex: 0,
        type: 'Cell',
        label: 'Dictionary',
        hittable: true,
        rect: { x: 0, y: 100, width: 800, height: 44 },
      },
    ]),
  );

  const listed = await device.selectors.find({
    session: 'default',
    query: 'Dictionary',
    action: 'list',
  });

  assert.equal(listed.kind, 'list');
  assert.deepEqual(
    listed.matches.map((entry) => entry.ref),
    ['@e2'],
  );
});

// #4685: a text-locator value read sees every match (its capture is not scoped to the first one)
// and shares the mutating find's refusal, so `get text` cannot silently read one of several rows.
test('runtime find get text refuses several text matches unless --first or --last picks one', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([APPLICATION, followButton(1, 0), followButton(2, 90), followButton(3, 180)]),
  );

  const error = await device.selectors
    .find({ session: 'default', locator: 'text', query: 'Follow', action: 'get_text' })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'AMBIGUOUS_MATCH');
  assert.deepEqual(readElementMatchCandidateRefs(error.details), ['e2', 'e3', 'e4']);

  const last = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Follow',
    action: 'get_text',
    findLast: true,
  });
  assert.equal(last.kind === 'text' ? last.ref : undefined, '@e4');
});

// #4685 review: a value read counts the candidate set mutating find binds (`findOneNodeCandidates`),
// so a read and a click on the same query never bind different nodes.
test('runtime find get text never counts the application root that click excludes', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([
      { ...APPLICATION, label: 'Settings' },
      {
        index: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Settings',
        hittable: true,
        rect: { x: 0, y: 100, width: 80, height: 40 },
      },
    ]),
  );

  const read = await device.selectors.find({
    session: 'default',
    locator: 'label',
    query: 'Settings',
    action: 'get_text',
  });
  assert.equal(read.kind === 'text' ? read.ref : undefined, '@e2');
});

test('runtime find get text binds the onscreen match over an offscreen duplicate', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([
      APPLICATION,
      followButton(1, 0),
      { ...followButton(2, 0), rect: { x: 0, y: 2400, width: 80, height: 40 } },
    ]),
  );

  const read = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Follow',
    action: 'get_text',
  });
  assert.equal(read.kind === 'text' ? read.ref : undefined, '@e2');

  // The offscreen twin is not a candidate, so --last cannot reach it by document order.
  const last = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Follow',
    action: 'get_text',
    findLast: true,
  });
  assert.equal(last.kind === 'text' ? last.ref : undefined, '@e2');
});

// #4699 review: on a producer that issues its own refs (web, agent-browser), a static text line it
// left unaddressed has no ref and no rect. A value read only reports text, so it must still find
// that node, as `find list`, `wait text` and `snapshot` do.
test('runtime find get text reads a ref-less, rectless text node', async () => {
  const [root, total] = makeSnapshotState([
    APPLICATION,
    { index: 1, parentIndex: 0, type: 'StaticText', label: 'Order total $42.00' },
  ]).nodes;
  const { ref: _unissued, ...refless } = total!;
  assert.equal(refless.rect, undefined);
  const device = createSelectorDevice({ nodes: [root!, refless], createdAt: Date.now() });

  const read = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Order total',
    action: 'get_text',
  });
  assert.equal(read.kind, 'text');
  assert.equal(read.kind === 'text' ? read.text : undefined, 'Order total $42.00');
});
