import { expect, test } from 'vitest';
import { presentIosInteractiveSnapshot } from './index.ts';
import {
  closedComposerWithRetainedActionShelfNodes,
  closedComposerWithRetainedRegularTreeActionNodes,
  openComposerActionShelfNodes,
} from './transitions.fixtures.ts';

test('iOS presentation removes an action shelf whose child actions moved outside its viewport', () => {
  const nodes = presentIosInteractiveSnapshot(closedComposerWithRetainedActionShelfNodes);
  const labels = nodes.map((node) => node.label).filter(Boolean);

  expect(labels).toEqual([
    'Fixture app',
    'Upload',
    'Upload',
    'Record Voice Message',
    'Record Voice Message',
  ]);
  expect(nodes.some((node) => node.identifier === 'GrowingTextView')).toBe(true);
});

test('iOS presentation removes retained regular-tree actions while the shelf toggle is collapsed', () => {
  const nodes = presentIosInteractiveSnapshot(closedComposerWithRetainedRegularTreeActionNodes);

  expect(nodes.some((node) => node.label === 'action file')).toBe(false);
  expect(nodes.some((node) => node.identifier === 'GrowingTextView')).toBe(true);
});

test('iOS presentation keeps an action shelf whose child actions are inside its viewport', () => {
  const nodes = presentIosInteractiveSnapshot(openComposerActionShelfNodes);
  const actionLabels = nodes
    .map((node) => node.label)
    .filter((label) => label?.startsWith('action '));

  expect(actionLabels).toEqual([
    'action media library',
    'action media library',
    'action sticker',
    'action file',
    'action poll',
    'action location',
    'action camera',
  ]);
});
