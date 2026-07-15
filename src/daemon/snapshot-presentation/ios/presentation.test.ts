import { expect, test } from 'vitest';
import { attachRefs, type RawSnapshotNode } from '../../../kernel/snapshot.ts';
import { buildSnapshotVisibility } from '../../../snapshot/snapshot-visibility.ts';
import { presentIosInteractiveSnapshot } from './index.ts';

function buildSnapshotState(data: { nodes?: RawSnapshotNode[]; backend?: 'xctest' }) {
  return {
    nodes: attachRefs(presentIosInteractiveSnapshot(data.nodes ?? [])),
    backend: data.backend,
    createdAt: Date.now(),
  };
}

test('buildSnapshotState collapses iOS interactive row backing nodes', () => {
  const rowRect = { x: 16, y: 293, width: 370, height: 52 };
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    { index: 1, depth: 1, parentIndex: 0, type: 'CollectionView' },
    { index: 2, depth: 2, parentIndex: 1, type: 'Cell', label: 'General', rect: rowRect },
    { index: 3, depth: 3, parentIndex: 2, type: 'Other', label: 'General', rect: rowRect },
    {
      index: 4,
      depth: 4,
      parentIndex: 3,
      type: 'Button',
      label: 'General',
      identifier: 'com.apple.settings.general',
      rect: rowRect,
    },
    { index: 5, depth: 5, parentIndex: 4, type: 'StaticText', label: 'General', rect: rowRect },
    {
      index: 6,
      depth: 5,
      parentIndex: 4,
      type: 'Image',
      identifier: 'chevron.forward',
      rect: { x: 360, y: 313, width: 7, height: 12 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.identifier])).toEqual([
    ['Application', 'Settings', undefined],
    ['CollectionView', undefined, undefined],
    ['Cell', 'General', 'com.apple.settings.general'],
  ]);
});

test('buildSnapshotState promotes iOS switch rows to the switch control', () => {
  const rowRect = { x: 16, y: 293, width: 370, height: 52 };
  const switchRect = { x: 320, y: 302, width: 51, height: 31 };
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    { index: 1, depth: 1, parentIndex: 0, type: 'CollectionView' },
    { index: 2, depth: 2, parentIndex: 1, type: 'Cell', label: 'Airplane Mode', rect: rowRect },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Airplane Mode',
      identifier: 'com.apple.settings.airplane-mode',
      rect: rowRect,
    },
    {
      index: 4,
      depth: 4,
      parentIndex: 3,
      type: 'Switch',
      label: 'Airplane Mode',
      value: '0',
      rect: switchRect,
    },
    {
      index: 5,
      depth: 5,
      parentIndex: 4,
      type: 'Switch',
      label: '0',
      value: '0',
      rect: { x: 320, y: 302, width: 51, height: 31 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.identifier])).toEqual([
    ['Application', 'Settings', undefined],
    ['CollectionView', undefined, undefined],
    ['Switch', 'Airplane Mode', 'com.apple.settings.airplane-mode'],
  ]);
  expect(state.nodes[2]?.parentIndex).toBe(1);
});

test('buildSnapshotState ignores unlabeled accessory buttons when collapsing iOS rows', () => {
  const rowRect = { x: 16, y: 293, width: 370, height: 52 };
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    { index: 1, depth: 1, parentIndex: 0, type: 'CollectionView' },
    { index: 2, depth: 2, parentIndex: 1, type: 'Cell', label: 'General', rect: rowRect },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      identifier: 'accessory-button',
      rect: rowRect,
    },
    {
      index: 4,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'General',
      identifier: 'com.apple.settings.general',
      rect: rowRect,
    },
    { index: 5, depth: 4, parentIndex: 4, type: 'StaticText', label: 'General', rect: rowRect },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.identifier])).toEqual([
    ['Application', 'Settings', undefined],
    ['CollectionView', undefined, undefined],
    ['Cell', 'General', 'com.apple.settings.general'],
  ]);
});

test('buildSnapshotState collapses inset iOS rows with text-area buttons and disabled chevrons', () => {
  const rowRect = { x: 20, y: 391, width: 362, height: 53 };
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Table', label: 'General' },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'About',
      identifier: 'About',
      rect: rowRect,
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'About',
      rect: { x: 20, y: 391, width: 331, height: 53 },
    },
    {
      index: 4,
      depth: 4,
      parentIndex: 3,
      type: 'Button',
      label: 'About',
      identifier: 'About',
      rect: { x: 34, y: 404, width: 88, height: 28 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'chevron',
      enabled: false,
      rect: { x: 351, y: 410, width: 10, height: 14 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.identifier])).toEqual([
    ['Application', 'Settings', undefined],
    ['Table', 'General', undefined],
    ['Cell', 'About', 'About'],
  ]);
});

test('buildSnapshotState collapses iOS rows with only repeated text and disabled chevrons', () => {
  const rowRect = { x: 20, y: 441, width: 362, height: 53 };
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Table', label: 'Camera' },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Formats',
      identifier: 'CameraFormatsSettingsList',
      rect: rowRect,
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Formats',
      rect: { x: 20, y: 441, width: 331, height: 53 },
    },
    {
      index: 4,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'chevron',
      enabled: false,
      rect: { x: 351, y: 458, width: 10, height: 14 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.identifier])).toEqual([
    ['Application', 'Settings', undefined],
    ['Table', 'Camera', undefined],
    ['Cell', 'Formats', 'CameraFormatsSettingsList'],
  ]);
});

test('buildSnapshotState collapses duplicate descendants under scoped iOS action roots', () => {
  const rowRect = { x: 16, y: 293, width: 370, height: 52 };
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'General',
      identifier: 'com.apple.settings.general',
      rect: rowRect,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Image',
      identifier: 'chevron.forward',
      rect: { x: 360, y: 313, width: 7, height: 12 },
    },
    { index: 2, depth: 1, parentIndex: 0, type: 'StaticText', label: 'General', rect: rowRect },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.identifier])).toEqual([
    ['Button', 'General', 'com.apple.settings.general'],
  ]);
});

test('buildSnapshotState collapses iOS other wrappers around same-rect actions', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'New Expensify Dev' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Press release, Expensify named Expense Platform of the Year',
      rect: { x: 20, y: 489, width: 362, height: 64 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Press release, Expensify named Expense Platform of the Year',
      rect: { x: 20, y: 489, width: 362, height: 64 },
    },
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Open actions menu',
      rect: { x: 334, y: 710, width: 52, height: 52 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 3,
      type: 'Button',
      label: 'Open actions menu',
      identifier: 'floating-action-button',
      rect: { x: 334, y: 710, width: 52, height: 52 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 4,
      type: 'Other',
      identifier: 'fab-animated-container',
      rect: { x: 334, y: 710, width: 52, height: 52 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(
    state.nodes.map((node) => [node.type, node.label, node.identifier, node.parentIndex]),
  ).toEqual([
    ['Application', 'New Expensify Dev', undefined, undefined],
    ['Button', 'Press release, Expensify named Expense Platform of the Year', undefined, 0],
    ['Button', 'Open actions menu', 'floating-action-button', 0],
  ]);
});

test('buildSnapshotState narrows an iOS RedBox dismiss wrapper around its minimize action', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Log 1 of 1',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Call Stack',
      rect: { x: 12, y: 468, width: 369, height: 20 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Dismiss',
      rect: { x: 0, y: 770, width: 393, height: 82 },
    },
    {
      index: 4,
      depth: 3,
      parentIndex: 3,
      type: 'Other',
      label: 'Minimize',
      rect: { x: 196.6666717529297, y: 770.25, width: 196.0833282470703, height: 81.5 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.find((node) => node.label === 'Dismiss')?.rect).toEqual({
    x: 0,
    y: 770,
    width: 196.6666717529297,
    height: 82,
  });
});

test('buildSnapshotState uses the innermost iOS RedBox dismiss action geometry', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Log 1 of 1',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Dismiss',
      rect: { x: 0, y: 770, width: 393, height: 82 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Dismiss',
      rect: { x: 0, y: 770, width: 196.6666717529297, height: 82 },
    },
    {
      index: 4,
      depth: 4,
      parentIndex: 3,
      type: 'Other',
      label: 'Dismiss',
      rect: { x: 0, y: 770, width: 196.6666717529297, height: 48 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Minimize',
      rect: { x: 196.6666717529297, y: 770, width: 196.3333282470703, height: 82 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.find((node) => node.label === 'Dismiss')?.rect).toEqual({
    x: 0,
    y: 770,
    width: 196.6666717529297,
    height: 48,
  });
});

test('buildSnapshotState promotes iOS scroll-contained other rows to cells', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'New Expensify Dev',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: '!, Open debugger to view warnings.',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'ScrollView',
      label: 'Recent chats',
      rect: { x: 8, y: 212, width: 386, height: 600 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 2,
      type: 'Other',
      label: 'Recent chats',
      rect: { x: 0, y: 220, width: 402, height: 16 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 2,
      type: 'Other',
      label: 'Receipt missing details, Receipt scanning failed. Enter details manually.',
      rect: { x: 8, y: 367, width: 386, height: 64 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.parentIndex])).toEqual([
    ['Application', 'New Expensify Dev', undefined],
    ['Other', '!, Open debugger to view warnings.', 0],
    ['ScrollView', 'Recent chats', 0],
    ['Other', 'Recent chats', 2],
    ['Cell', 'Receipt missing details, Receipt scanning failed. Enter details manually.', 2],
  ]);
});

test('buildSnapshotState keeps React Native warning banner instead of full-screen wrapper', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'New Expensify Dev',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: '!, Open debugger to view warnings.',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      identifier: 'SearchRouterPage',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: '!, Open debugger to view warnings.',
      rect: { x: 10, y: 786.666, width: 382, height: 67.333 },
    },
    {
      index: 4,
      depth: 3,
      parentIndex: 3,
      type: 'Other',
      label: '!, Open debugger to view warnings.',
      rect: { x: 10, y: 787.333, width: 382, height: 48 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(
    state.nodes.map((node) => [node.type, node.label, node.rect?.y, node.parentIndex]),
  ).toEqual([
    ['Application', 'New Expensify Dev', 0, undefined],
    ['Other', '!, Open debugger to view warnings.', 786.666, 0],
  ]);
});

test('buildSnapshotState collapses iOS backdrop dismiss wrappers', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'New Expensify Dev' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Dismiss',
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Dismiss',
      rect: { x: 0, y: 458, width: 402, height: 10 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Create expense',
      rect: { x: 0, y: 474, width: 402, height: 64 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.parentIndex])).toEqual([
    ['Application', 'New Expensify Dev', undefined],
    ['Button', 'Dismiss', 0],
    ['Button', 'Create expense', 0],
  ]);
});

test('buildSnapshotState collapses iOS back and text-field wrappers', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'New Expensify Dev' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Back',
      rect: { x: 0, y: 62, width: 402, height: 72 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Back',
      rect: { x: 8, y: 78, width: 40, height: 40 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Search',
      rect: { x: 48, y: 88, width: 54, height: 20 },
    },
    {
      index: 4,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Search for something...',
      rect: { x: 21, y: 147, width: 360, height: 52 },
    },
    {
      index: 5,
      depth: 2,
      parentIndex: 4,
      type: 'TextField',
      label: 'Search for something...',
      identifier: 'search-autocomplete-text-input',
      rect: { x: 33, y: 147, width: 336, height: 52 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(
    state.nodes.map((node) => [node.type, node.label, node.identifier, node.parentIndex]),
  ).toEqual([
    ['Application', 'New Expensify Dev', undefined, undefined],
    ['Button', 'Back', undefined, 0],
    ['StaticText', 'Search', undefined, 0],
    ['TextField', 'Search for something...', 'search-autocomplete-text-input', 0],
  ]);
});

test('buildSnapshotState suppresses offscreen iOS keyboard subtrees', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'New Expensify Dev',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'SearchRouterPage',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Padding-Left',
      rect: { x: 0, y: 874, width: 402, height: 233 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 2,
      type: 'Keyboard',
      label: 'Padding-Left',
      rect: { x: 0, y: 874, width: 402, height: 233 },
    },
    {
      index: 4,
      depth: 3,
      parentIndex: 3,
      type: 'Key',
      label: 'q',
      rect: { x: 4, y: 881, width: 39, height: 54 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label])).toEqual([
    ['Application', 'New Expensify Dev'],
    ['Other', 'SearchRouterPage'],
  ]);
});

test('buildSnapshotState does not use scoped root rect as iOS keyboard viewport', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Other',
      label: 'Search form',
      rect: { x: 0, y: 120, width: 402, height: 52 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Keyboard',
      label: 'Padding-Left',
      rect: { x: 0, y: 874, width: 402, height: 233 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Key',
      label: 'q',
      rect: { x: 4, y: 881, width: 39, height: 54 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label])).toEqual([
    ['Other', 'Search form'],
    ['Keyboard', 'Padding-Left'],
    ['Key', 'q'],
  ]);
});

test('buildSnapshotState suppresses structural iOS identifier-only nodes', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'New Expensify Dev' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      identifier: 'SearchRouterPage',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Receipt missing details',
      rect: { x: 8, y: 240, width: 386, height: 64 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 2,
      type: 'Other',
      identifier: 'ReportActionAvatars-SingleAvatar',
      rect: { x: 20, y: 252, width: 40, height: 40 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(
    state.nodes.map((node) => [node.type, node.label, node.identifier, node.parentIndex]),
  ).toEqual([
    ['Application', 'New Expensify Dev', undefined, undefined],
    ['Other', 'Receipt missing details', undefined, 0],
  ]);
});

test('buildSnapshotState collapses duplicated iOS search toolbar wrappers', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', label: 'Toolbar' },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'SearchField',
      label: 'Toolbar',
      identifier: 'Toolbar',
      rect: { x: 0, y: 788, width: 402, height: 86 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Search',
      rect: { x: 28, y: 798, width: 0, height: 0 },
    },
    {
      index: 4,
      depth: 4,
      parentIndex: 3,
      type: 'Other',
      label: 'Search',
      rect: { x: 28, y: 798, width: 346, height: 48 },
    },
    {
      index: 5,
      depth: 5,
      parentIndex: 4,
      type: 'SearchField',
      label: 'Search',
      rect: { x: 33, y: 803, width: 336, height: 38 },
    },
    {
      index: 6,
      depth: 6,
      parentIndex: 5,
      type: 'Button',
      label: 'Dictate',
      identifier: 'Dictate',
      rect: { x: 335, y: 811, width: 17, height: 22 },
    },
    {
      index: 7,
      depth: 6,
      parentIndex: 5,
      type: 'Image',
      label: 'Search',
      identifier: 'magnifyingglass',
      rect: { x: 46, y: 812, width: 20, height: 18 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(
    state.nodes.map((node) => [node.type, node.label, node.identifier, node.parentIndex]),
  ).toEqual([
    ['Application', 'Settings', undefined, undefined],
    ['SearchField', 'Search', undefined, 0],
    ['Button', 'Dictate', 'Dictate', 1],
  ]);
});

test('buildSnapshotState collapses exposed iOS search field wrappers', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Search',
      rect: { x: 28, y: 798, width: 0, height: 0 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'SearchField',
      label: 'Search',
      rect: { x: 33, y: 803, width: 336, height: 38 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Dictate',
      identifier: 'Dictate',
      rect: { x: 335, y: 811, width: 17, height: 22 },
    },
    {
      index: 4,
      depth: 3,
      parentIndex: 2,
      type: 'Image',
      label: 'Search',
      identifier: 'magnifyingglass',
      rect: { x: 46, y: 812, width: 20, height: 18 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(
    state.nodes.map((node) => [node.type, node.label, node.identifier, node.parentIndex]),
  ).toEqual([
    ['Application', 'Settings', undefined, undefined],
    ['SearchField', 'Search', undefined, 0],
    ['Button', 'Dictate', 'Dictate', 1],
  ]);
});

test('buildSnapshotState collapses duplicated iOS static and link surfaces', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    { index: 1, depth: 1, parentIndex: 0, type: 'Table', label: 'Camera' },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Composition',
      rect: { x: 0, y: 564, width: 402, height: 38 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Composition',
      rect: { x: 20, y: 564, width: 362, height: 38 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'About Camera and ARKit & Privacy…',
      rect: { x: 0, y: 760, width: 402, height: 32 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 4,
      type: 'Link',
      label: 'About Camera and ARKit & Privacy…',
      rect: { x: 0, y: 760, width: 402, height: 32 },
    },
    {
      index: 6,
      depth: 4,
      parentIndex: 5,
      type: 'Link',
      label: 'About Camera and ARKit & Privacy…',
      rect: { x: 0, y: 115, width: 0, height: 17 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.parentIndex])).toEqual([
    ['Application', 'Settings', undefined],
    ['Table', 'Camera', 0],
    ['Other', 'Composition', 1],
    ['Link', 'About Camera and ARKit & Privacy…', 1],
  ]);
});

test('buildSnapshotState collapses nested duplicated iOS static text', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'New Expensify Dev' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: "You're done!",
      rect: { x: 137, y: 302, width: 128, height: 27 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: "You're done!",
      rect: { x: 137, y: 302, width: 128, height: 27 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.parentIndex])).toEqual([
    ['Application', 'New Expensify Dev', undefined],
    ['StaticText', "You're done!", 0],
  ]);
});

test('buildSnapshotState collapses duplicated iOS scrollable wrappers', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Camera',
      rect: { x: 0, y: 116, width: 402, height: 724 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Table',
      label: 'Camera',
      rect: { x: 0, y: 116, width: 402, height: 724 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Cell',
      label: 'Formats',
      rect: { x: 20, y: 441, width: 362, height: 53 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label, node.parentIndex])).toEqual([
    ['Application', 'Settings', undefined],
    ['Table', 'Camera', 0],
    ['Cell', 'Formats', 1],
  ]);
});

test('buildSnapshotVisibility keeps iOS hidden-below hints after row collapse', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      label: 'Settings',
      rect: { x: 0, y: 100, width: 402, height: 300 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Below',
      rect: { x: 20, y: 430, width: 362, height: 53 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 4,
      type: 'Button',
      label: 'Below',
      rect: { x: 20, y: 430, width: 362, height: 53 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });
  const visibility = buildSnapshotVisibility({ nodes: state.nodes, backend: state.backend });

  expect(visibility.reasons).toContain('scroll-hidden-below');
  expect(visibility.reasons).not.toContain('scroll-hidden-above');
});

test('buildSnapshotState transfers iOS scroll indicator values to scroll containers', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'CollectionView',
      label: 'Vertical scroll bar, 2 pages',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Cell',
      label: 'General',
      rect: { x: 16, y: 293, width: 370, height: 52 },
    },
    {
      index: 4,
      depth: 4,
      parentIndex: 3,
      type: 'Button',
      label: 'General',
      rect: { x: 16, y: 293, width: 370, height: 52 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      value: '0%',
      rect: { x: 369, y: 116, width: 30, height: 672 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });

  expect(state.nodes.map((node) => [node.type, node.label])).toEqual([
    ['Application', 'Settings'],
    ['CollectionView', 'Vertical scroll bar, 2 pages'],
    ['Cell', 'General'],
  ]);
  expect(state.nodes[1]?.hiddenContentAbove).toBeUndefined();
  expect(state.nodes[1]?.hiddenContentBelow).toBe(true);
  expect(state.nodes[1]?.rect).toEqual({ x: 0, y: 116, width: 402, height: 672 });
});

test('buildSnapshotVisibility keeps iOS hidden-above hints after row collapse', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      label: 'Settings',
      rect: { x: 0, y: 100, width: 402, height: 300 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Above',
      rect: { x: 20, y: 20, width: 362, height: 53 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Above',
      rect: { x: 20, y: 20, width: 362, height: 53 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 4,
      type: 'Button',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });
  const visibility = buildSnapshotVisibility({ nodes: state.nodes, backend: state.backend });

  expect(visibility.reasons).toContain('scroll-hidden-above');
  expect(visibility.reasons).not.toContain('scroll-hidden-below');
});

test('buildSnapshotState transfers bottomed iOS scroll indicators without hidden-below', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Application', label: 'Settings' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      label: 'Settings',
      rect: { x: 0, y: 100, width: 402, height: 300 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Visible',
      rect: { x: 20, y: 120, width: 362, height: 53 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      value: '100%',
      rect: { x: 369, y: 116, width: 30, height: 672 },
    },
  ];

  const state = buildSnapshotState({ nodes, backend: 'xctest' });
  const visibility = buildSnapshotVisibility({ nodes: state.nodes, backend: state.backend });

  expect(state.nodes[1]?.hiddenContentAbove).toBe(true);
  expect(state.nodes[1]?.hiddenContentBelow).toBeUndefined();
  expect(visibility.reasons).toContain('scroll-hidden-above');
  expect(visibility.reasons).not.toContain('scroll-hidden-below');
});
