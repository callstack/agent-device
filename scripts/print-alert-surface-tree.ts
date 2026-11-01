// Prints one tree of an alert surface corpus recording, one node per line, so a contributor can
// write its `expectModalScope` by hand. See apple/snapshot-presentation/Tests/AlertSurfaceCorpus/README.md.
import fs from 'node:fs';

type RecordedNode = {
  index: number;
  parentIndex?: number;
  element: string;
  type: string;
  label: string;
};

const [file, treeName = 'honorModal'] = process.argv.slice(2);
if (!file || (treeName !== 'honorModal' && treeName !== 'plain')) {
  throw new Error('Usage: pnpm print:alert-surface <recording.json> [honorModal|plain]');
}
const recording = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, RecordedNode[]>;
const nodes = recording[treeName];
const plain = recording.plain;

// A node is its element under its parent's element, the identity the modal-scope pair matches on.
const key = (tree: RecordedNode[], node: RecordedNode) =>
  `${node.parentIndex === undefined ? '' : tree[node.parentIndex].element}>${node.element}`;
const childCounts = (tree: RecordedNode[]) => {
  const counts = new Map<string, number>();
  for (const node of tree) {
    if (node.parentIndex === undefined) continue;
    const parent = key(tree, tree[node.parentIndex]);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
};
const plainChildCounts = childCounts(plain);
const keptChildCounts = childCounts(nodes);

const depths: number[] = [];
for (const node of nodes) {
  depths[node.index] = node.parentIndex === undefined ? 0 : depths[node.parentIndex] + 1;
  const kept = keptChildCounts.get(key(nodes, node)) ?? 0;
  const listed = plainChildCounts.get(key(nodes, node)) ?? 0;
  const removed =
    treeName === 'honorModal' && listed > kept ? `  [kept ${kept} of ${listed} children]` : '';
  console.log(
    `${String(node.index).padStart(4)} ${'  '.repeat(depths[node.index])}${node.type} ${JSON.stringify(node.label)}${removed}`,
  );
}
