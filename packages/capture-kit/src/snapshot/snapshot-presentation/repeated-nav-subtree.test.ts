import { test } from 'vitest';
import assert from 'node:assert/strict';
import { detectPossibleRepeatedNavSubtree } from './repeated-nav-subtree.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { formatRole } from '@agent-device/kernel/snapshot';

test('detectPossibleRepeatedNavSubtree warns for overlapping duplicate rows', () => {
  const nodes = makeNodes(24, (index) => ({
    type: index === 0 ? 'android.widget.FrameLayout' : 'android.widget.Button',
    label: index === 0 ? 'Root' : 'Inbox',
    rect:
      index === 0
        ? { x: 0, y: 0, width: 1080, height: 2400 }
        : { x: 20, y: 40, width: 300, height: 48 },
  }));

  assert.equal(detectPossibleRepeatedNavSubtree(nodes), true);
});

test('detectPossibleRepeatedNavSubtree does not warn for repeated list rows', () => {
  const nodes = makeNodes(24, (index) => ({
    type: index === 0 ? 'android.widget.FrameLayout' : 'android.widget.Button',
    label: index === 0 ? 'Root' : 'Receipt missing details',
    rect:
      index === 0
        ? { x: 0, y: 0, width: 1080, height: 2400 }
        : { x: 20, y: 40 + index * 80, width: 300, height: 48 },
  }));

  assert.equal(detectPossibleRepeatedNavSubtree(nodes), false);
});

test('detectPossibleRepeatedNavSubtree tolerates subpixel adjacent list rows', () => {
  const nodes = makeNodes(24, (index) => ({
    type: index === 0 ? 'android.widget.FrameLayout' : 'android.widget.Button',
    label: index === 0 ? 'Root' : 'Receipt missing details',
    rect:
      index === 0
        ? { x: 0, y: 0, width: 1080, height: 2400 }
        : { x: 20, y: 40 + index * 63.99998, width: 300, height: 64 },
  }));

  assert.equal(detectPossibleRepeatedNavSubtree(nodes), false);
});

test('detectPossibleRepeatedNavSubtree does not warn for small trees', () => {
  const nodes = makeNodes(19, (index) => ({
    type: 'android.widget.Button',
    label: 'Inbox',
    rect: { x: 20, y: 40 + index * 80, width: 300, height: 48 },
  }));

  assert.equal(detectPossibleRepeatedNavSubtree(nodes), false);
});

test('detectPossibleRepeatedNavSubtree does not warn when duplicates are below threshold', () => {
  const nodes = makeNodes(20, (index) => ({
    type: 'android.widget.Button',
    label: index < 7 ? `Unique${index}` : index < 10 ? 'Shared' : `Other${index}`,
    rect: { x: 20, y: 40 + index * 80, width: 300, height: 48 },
  }));

  assert.equal(detectPossibleRepeatedNavSubtree(nodes), false);
});

const EMAIL_LIKE_REFERENCE = /\S+@\S+\.\S+/;

test.each([
  ['user@example.com', true],
  ['Signed in as User@Example.com today', true],
  ['a@b.c', true],
  ['a@@b..c', true],
  ['@a@b.c', true],
  ['a.b@c.d.e', true],
  ['x a@b.c', true],
  ['user@example', false],
  ['@example.com', false],
  ['user@.com', false],
  ['user@example.', false],
  ['a@ b.c', false],
  ['a @b.c', false],
  ['a@b .c', false],
  ['a.b@c', false],
  ['Inbox', false],
  ['@', false],
  ['a@b.', false],
])('detectPossibleRepeatedNavSubtree treats %j as email-like: %s', (label, emailLike) => {
  assert.equal(EMAIL_LIKE_REFERENCE.test(label.toLowerCase()), emailLike);
  assert.equal(detectPossibleRepeatedNavSubtree(makeOverlappingDuplicates(label)), !emailLike);
});

test.each([
  ['@'.repeat(50_000)],
  ['a@'.repeat(25_000)],
  ['a@b'.repeat(20_000)],
  [`${'a@'.repeat(25_000)}.`],
])('detectPossibleRepeatedNavSubtree classifies adversarial labels in linear time', (label) => {
  const startedAt = performance.now();
  assert.equal(detectPossibleRepeatedNavSubtree(makeOverlappingDuplicates(label)), true);
  assert.ok(performance.now() - startedAt < 1_000);
});

function makeOverlappingDuplicates(label: string): SnapshotNode[] {
  return makeNodes(24, (index) => ({
    type: index === 0 ? 'android.widget.FrameLayout' : 'android.widget.Button',
    label: index === 0 ? 'Root' : label,
    rect:
      index === 0
        ? { x: 0, y: 0, width: 1080, height: 2400 }
        : { x: 20, y: 40, width: 300, height: 48 },
  }));
}

function makeNodes(
  count: number,
  build: (index: number) => Pick<SnapshotNode, 'type' | 'label' | 'rect'>,
): SnapshotNode[] {
  return Array.from({ length: count }, (_, index) => {
    const built = build(index);
    return {
      ref: `e${index + 1}`,
      index,
      depth: index === 0 ? 0 : 1,
      hittable: index !== 0,
      enabled: true,
      kind: formatRole(built.type ?? 'Element'),
      ...built,
    };
  });
}
