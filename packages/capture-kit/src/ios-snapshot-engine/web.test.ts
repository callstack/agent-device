import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { presentIosInteractiveSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';

test('projects iOS WebKit heading and text wrappers to semantic roles', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application', label: 'Example' },
    { index: 1, depth: 1, parentIndex: 0, type: 'WebView', label: 'Example page' },
    { index: 2, depth: 2, parentIndex: 1, type: 'Other', label: 'Example page' },
    { index: 3, depth: 3, parentIndex: 2, type: 'Other', label: 'Welcome', value: '1' },
    { index: 4, depth: 4, parentIndex: 3, type: 'StaticText', label: 'Welcome' },
    { index: 5, depth: 3, parentIndex: 2, type: 'Other', label: 'Introduction' },
    { index: 6, depth: 4, parentIndex: 5, type: 'StaticText', label: 'Introduction' },
    { index: 7, depth: 3, parentIndex: 2, type: 'Link', label: 'Read more' },
  ];

  expect(
    presentIosInteractiveSnapshot(nodes).map((node) => [
      node.type,
      node.label,
      node.value,
      node.parentIndex,
    ]),
  ).toEqual([
    ['Application', 'Example', undefined, undefined],
    ['WebView', 'Example page', undefined, 0],
    ['Heading', 'Welcome', undefined, 1],
    ['StaticText', 'Introduction', undefined, 1],
    ['Link', 'Read more', undefined, 1],
  ]);
  expect(nodes[3]?.value).toBe('1');
});

test('recognizes numeric WebView types from retained older runners', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Element(58)', label: 'Example page' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Body copy' },
    { index: 2, depth: 2, parentIndex: 1, type: 'StaticText', label: 'Body copy' },
  ];

  expect(presentIosInteractiveSnapshot(nodes).map((node) => [node.type, node.label])).toEqual([
    ['WebView', 'Example page'],
    ['StaticText', 'Body copy'],
  ]);
});

test('keeps a nested heading whose label matches the WebView title', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'WebView', label: 'Same title' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Same title' },
    { index: 2, depth: 2, parentIndex: 1, type: 'Other', label: 'Same title', value: '1' },
    { index: 3, depth: 3, parentIndex: 2, type: 'StaticText', label: 'Same title' },
  ];

  expect(presentIosInteractiveSnapshot(nodes).map((node) => [node.type, node.label])).toEqual([
    ['WebView', 'Same title'],
    ['Heading', 'Same title'],
  ]);
});

test('keeps a heading through repeated WebKit document-title wrappers', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'WebView', label: 'Same title' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Same title' },
    { index: 2, depth: 2, parentIndex: 1, type: 'Other', label: 'Same title' },
    { index: 3, depth: 3, parentIndex: 2, type: 'Other', label: 'main' },
    { index: 4, depth: 4, parentIndex: 3, type: 'Other', label: 'Same title', value: '1' },
    { index: 5, depth: 5, parentIndex: 4, type: 'StaticText', label: 'Same title' },
  ];

  expect(presentIosInteractiveSnapshot(nodes).map((node) => [node.type, node.label])).toEqual([
    ['WebView', 'Same title'],
    ['Other', 'Same title'],
    ['Other', 'main'],
    ['Heading', 'Same title'],
  ]);
});

test('keeps a direct heading whose label matches the WebView title', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'WebView', label: 'Same title' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Same title', value: '1' },
    { index: 2, depth: 2, parentIndex: 1, type: 'StaticText', label: 'Same title' },
  ];

  expect(presentIosInteractiveSnapshot(nodes).map((node) => [node.type, node.label])).toEqual([
    ['WebView', 'Same title'],
    ['Heading', 'Same title'],
  ]);
});

test('does not infer text from a nested same-label descendant', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'WebView', label: 'Example' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Container' },
    { index: 2, depth: 2, parentIndex: 1, type: 'Button', label: 'Action' },
    { index: 3, depth: 3, parentIndex: 2, type: 'StaticText', label: 'Container' },
  ];

  expect(presentIosInteractiveSnapshot(nodes).map((node) => [node.type, node.label])).toEqual([
    ['WebView', 'Example'],
    ['Other', 'Container'],
    ['Button', 'Action'],
  ]);
});

test('keeps a labelled WebKit container with additional semantic content', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'WebView', label: 'Example' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'News' },
    { index: 2, depth: 2, parentIndex: 1, type: 'StaticText', label: 'News' },
    { index: 3, depth: 2, parentIndex: 1, type: 'Link', label: 'Read more' },
  ];

  expect(presentIosInteractiveSnapshot(nodes).map((node) => [node.type, node.label])).toEqual([
    ['WebView', 'Example'],
    ['Other', 'News'],
    ['Link', 'Read more'],
  ]);
});

test('does not infer semantic roles for matching wrappers outside a WebView', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application', label: 'Example' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Native copy', value: '1' },
    { index: 2, depth: 2, parentIndex: 1, type: 'StaticText', label: 'Native copy' },
  ];

  expect(presentIosInteractiveSnapshot(nodes).map((node) => [node.type, node.label])).toEqual([
    ['Application', 'Example'],
    ['Other', 'Native copy'],
  ]);
});
