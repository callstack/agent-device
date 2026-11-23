import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildComponentTree,
  findNodes,
  renderTree,
  resolveNode,
  type RawComponentTree,
} from './react-component-tree.ts';

const FUNCTION = 5;
const MEMO = 8;

/** Providers wrap the app, which renders a header and a list of rows. */
function appTree(rows = 3): RawComponentTree {
  const nodes: RawComponentTree['nodes'] = [
    [1, 'ThemeProvider', FUNCTION, 0, 0, null],
    [2, 'StoreProvider', FUNCTION, 1, 0, null],
    [3, 'NavigationContainer', FUNCTION, 2, 0, null],
    [4, 'Stack', FUNCTION, 3, 0, null],
    [5, 'Screen', FUNCTION, 4, 0, null],
    [6, 'App', FUNCTION, 5, 0, null],
    [7, 'Header', FUNCTION, 6, 6, null],
    [8, 'List', FUNCTION, 6, 6, null],
  ];
  for (let index = 0; index < rows; index += 1) {
    nodes.push([20 + index, 'Memo(Row)', MEMO, 8, 8, String(index)]);
    nodes.push([40 + index, 'Text', FUNCTION, 20 + index, 20 + index, null]);
  }
  return { nodes, order: {}, logs: { '21': [1, 0] }, logsTracked: true };
}

test('wrapper chains and runs of same-shape sibling rows each read as one line', () => {
  const raw = appTree();
  raw.logs = {};
  const view = renderTree(buildComponentTree(raw).roots, 8, 60);
  assert.deepEqual(view.lines, [
    '@c1 ThemeProvider > @c2 StoreProvider > (2 wrappers) > @c5 Screen > @c6 App',
    '  @c7 Header',
    '  @c8 List',
    '    @c20 Row [memo] key=0 x3 (+3 below)',
  ]);
  assert.equal(view.total, 14);
  assert.equal(view.shown, 11, 'the rows under a collapsed run are counted as not shown');
});

test('a row that logged a problem its neighbours did not keeps its own line', () => {
  const tree = buildComponentTree(appTree());
  assert.deepEqual(renderTree([tree.byId.get(8)!], 8, 60).lines, [
    '@c8 List',
    '  @c20 Row [memo] key=0 > @c40 Text',
    '  @c21 Row [memo] key=1 (1 error) > @c41 Text',
    '  @c22 Row [memo] key=2 > @c42 Text',
  ]);
});

test('siblings with equal subtree sizes but different children stay open', () => {
  const raw = appTree(0);
  raw.nodes.push(
    [30, 'Scene', FUNCTION, 8, 8, 'a'],
    [31, 'Header', FUNCTION, 30, 30, null],
    [32, 'Scene', FUNCTION, 8, 8, 'b'],
    [33, 'Form', FUNCTION, 32, 32, null],
    [34, 'Scene', FUNCTION, 8, 8, 'c'],
    [35, 'Header', FUNCTION, 34, 34, null],
  );
  assert.deepEqual(renderTree([buildComponentTree(raw).byId.get(8)!], 8, 60).lines, [
    '@c8 List',
    '  @c30 Scene key=a > @c31 Header',
    '  @c32 Scene key=b > @c33 Form',
    '  @c34 Scene key=c > @c35 Header',
  ]);
});

test('names and keys the app controls cannot start a line or reach the terminal', () => {
  const raw = appTree(0);
  raw.nodes.push([30, 'Evil\n@c1 Forged', FUNCTION, 8, 8, 'k\u001b[2J']);
  assert.deepEqual(renderTree([buildComponentTree(raw).byId.get(30)!], 8, 60).lines, [
    '@c30 Evil @c1 Forged key=k [2J',
  ]);
});

test('depth and line limits cut the tree and count what they leave out', () => {
  const tree = buildComponentTree(appTree());
  assert.deepEqual(renderTree(tree.roots, 1, 60).lines, [
    '@c1 ThemeProvider > @c2 StoreProvider > (2 wrappers) > @c5 Screen > @c6 App (+8 below)',
  ]);
  const limited = renderTree(tree.roots, 8, 2);
  assert.equal(limited.lines.length, 2);
  assert.equal(limited.shown, 7);
});

test('a recorded reorder puts children in their rendered order', () => {
  const raw = appTree(2);
  raw.order = { '8': [21, 20] };
  const list = buildComponentTree(raw).byId.get(8)!;
  assert.deepEqual(
    list.children.map((child) => child.id),
    [21, 20],
  );
});

test('same-name siblings of different shapes, such as navigator screens, stay open', () => {
  const raw = appTree(0);
  raw.nodes.push(
    [30, 'Scene', FUNCTION, 8, 8, 'home'],
    [31, 'Scene', FUNCTION, 8, 8, 'settings'],
    [32, 'Scene', FUNCTION, 8, 8, 'profile'],
    [33, 'Form', FUNCTION, 31, 31, null],
  );
  const tree = buildComponentTree(raw);
  assert.deepEqual(renderTree([tree.byId.get(8)!], 8, 60).lines, [
    '@c8 List',
    '  @c30 Scene key=home',
    '  @c31 Scene key=settings > @c33 Form',
    '  @c32 Scene key=profile',
  ]);
});

test('a branch renders with its logged problems on the line', () => {
  const tree = buildComponentTree(appTree(2));
  assert.deepEqual(renderTree([tree.byId.get(21)!], 8, 60).lines, [
    '@c21 Row [memo] key=1 (1 error) > @c41 Text',
  ]);
});

test('find matches part of a name unless asked for the exact name', () => {
  const tree = buildComponentTree(appTree());
  assert.deepEqual(
    findNodes(tree, 'provider', false).map((node) => node.name),
    ['ThemeProvider', 'StoreProvider'],
  );
  assert.deepEqual(findNodes(tree, 'provider', true), []);
});

test('a ref or a unique name selects one component; a shared name fails closed', () => {
  const tree = buildComponentTree(appTree());
  assert.equal(resolveNode(tree, '@c8').name, 'List');
  assert.equal(resolveNode(tree, 'header').id, 7);
  assert.throws(
    () => resolveNode(tree, 'Row'),
    (error: { code: string; message: string }) =>
      error.code === 'INVALID_ARGS' &&
      /3 mounted components are named Row: @c20, @c21, @c22/.test(error.message),
  );
  assert.throws(
    () => resolveNode(tree, '@c999'),
    (error: { details: { reason: string } }) => error.details.reason === 'element-not-found',
  );
  assert.throws(() => resolveNode(tree, 'Missing'), /No mounted component is named Missing/);
});
