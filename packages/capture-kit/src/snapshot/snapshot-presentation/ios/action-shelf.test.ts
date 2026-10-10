import { expect, test } from 'vitest';
import { buildIosInteractiveSnapshotPresentation } from '../../../ios-snapshot-engine/index.ts';
import {
  closedComposerWithRetainedActionShelfNodes,
  closedComposerWithRetainedRegularTreeActionNodes,
  openComposerActionShelfNodes,
} from './transitions.fixtures.ts';

test('iOS presentation removes an action shelf whose child actions moved outside its viewport', () => {
  const nodes = buildIosInteractiveSnapshotPresentation(
    closedComposerWithRetainedActionShelfNodes,
  ).nodes;
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
  const nodes = buildIosInteractiveSnapshotPresentation(
    closedComposerWithRetainedRegularTreeActionNodes,
  ).nodes;

  expect(nodes.some((node) => node.label === 'action file')).toBe(false);
  expect(nodes.some((node) => node.identifier === 'GrowingTextView')).toBe(true);
});

test('iOS presentation keeps an action shelf whose child actions are inside its viewport', () => {
  const nodes = buildIosInteractiveSnapshotPresentation(openComposerActionShelfNodes).nodes;
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
