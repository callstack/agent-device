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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [file, treeName = 'honorModal'] = process.argv.slice(2);
if (!file || (treeName !== 'honorModal' && treeName !== 'plain')) {
  fail('Usage: pnpm print:alert-surface <recording.json> [honorModal|plain]');
}
const recording = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
const plain = preorderTree('plain');
const nodes = treeName === 'plain' ? plain : preorderTree('honorModal');

// The same check as RecordedAlertSurface.load: each index is its position, and its parent comes before it.
function preorderTree(name: string): RecordedNode[] {
  const tree = recording[name];
  if (!Array.isArray(tree) || tree.length === 0) fail(`${file}: "${name}" is not a tree`);
  tree.forEach((node: RecordedNode, position) => {
    const parent = node.parentIndex;
    const parentIsValid =
      parent === undefined
        ? position === 0
        : Number.isInteger(parent) && parent >= 0 && parent < position;
    if (node.index !== position || !parentIsValid) {
      fail(`${file}: "${name}" node ${position} is out of preorder. Capture it again.`);
    }
  });
  return tree as RecordedNode[];
}

function childrenOf(tree: RecordedNode[]): number[][] {
  const children = tree.map((): number[] => []);
  for (const node of tree)
    if (node.parentIndex !== undefined) children[node.parentIndex].push(node.index);
  return children;
}

function countElements(tree: RecordedNode[], positions: number[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const position of positions) {
    counts.set(tree[position].element, (counts.get(tree[position].element) ?? 0) + 1);
  }
  return counts;
}

// Pairs each honor-modal node with one plain occurrence, the way ModalSurface walks the pair. An
// element listed more than once under one parent pairs in order when every occurrence is kept.
// When only some are kept, ModalSurface reads `unknown(duplicatedChild)`, so this stops there.
const markers = new Map<number, string>();
if (treeName === 'honorModal') {
  const plainChildren = childrenOf(plain);
  const keptChildren = childrenOf(nodes);
  const pairedPlain = new Map<number, number>();
  if (nodes[0].element === plain[0].element) pairedPlain.set(0, 0);
  for (const node of nodes) {
    const plainNode = pairedPlain.get(node.index);
    if (plainNode === undefined) continue;
    const listed = countElements(plain, plainChildren[plainNode]);
    const kept = countElements(nodes, keptChildren[node.index]);
    const ambiguous = [...kept].find(([element, count]) => {
      const listedCount = listed.get(element) ?? 0;
      return listedCount > 1 && count < listedCount;
    });
    if (ambiguous) {
      const [element, count] = ambiguous;
      markers.set(
        node.index,
        `[duplicatedChild: kept ${count} of ${listed.get(element)} occurrences of ${element}]`,
      );
      continue;
    }
    const removed = [...plainChildren[plainNode]];
    for (const child of keptChildren[node.index]) {
      const match = removed.findIndex(
        (position) => plain[position].element === nodes[child].element,
      );
      if (match >= 0) pairedPlain.set(child, removed.splice(match, 1)[0]);
    }
    if (removed.length > 0 && keptChildren[node.index].length > 0) {
      markers.set(
        node.index,
        `[kept ${keptChildren[node.index].length} of ${plainChildren[plainNode].length} children]`,
      );
    }
  }
}

const depths: number[] = [];
for (const node of nodes) {
  depths[node.index] = node.parentIndex === undefined ? 0 : depths[node.parentIndex] + 1;
  const marker = markers.has(node.index) ? `  ${markers.get(node.index)}` : '';
  console.log(
    `${String(node.index).padStart(4)} ${'  '.repeat(depths[node.index])}${node.type} ${JSON.stringify(node.label)}${marker}`,
  );
}
