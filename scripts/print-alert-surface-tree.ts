// Prints one tree of an alert surface corpus recording, one node per line, so a contributor can
// write its `expectModalScope` by hand. See apple/snapshot-presentation/Tests/AlertSurfaceCorpus/README.md.
import fs from 'node:fs';

type RecordedNode = {
  index: number;
  parentIndex?: number;
  element: string;
  type: string;
  label: string;
  rect: unknown;
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

// The reading ModalSurface.read gives the pair, ported step for step from ModalScopePair.pair and
// ModalSurface.read so the printer never marks a surface the rule would not read. A capture records
// no confirming tree, so `screenChanged` is not checked here.
type Reading =
  | { kind: 'noExclusion' }
  | { kind: 'modal'; markers: Map<number, string> }
  | { kind: 'unknown'; reason: string };

function pairInstability(honorModal: RecordedNode[]): string | undefined {
  const keyOf = (tree: RecordedNode[], node: RecordedNode) =>
    JSON.stringify([
      node.element,
      node.parentIndex === undefined ? null : tree[node.parentIndex].element,
    ]);
  const frameOf = (node: RecordedNode) => JSON.stringify(node.rect);
  const unmatched = new Map<string, { frame: string; count: number }>();
  for (const node of plain) {
    const key = keyOf(plain, node);
    unmatched.set(key, { frame: frameOf(node), count: (unmatched.get(key)?.count ?? 0) + 1 });
  }
  const plainElements = new Set(plain.map((node) => node.element));
  for (const node of honorModal) {
    const match = unmatched.get(keyOf(honorModal, node));
    if (!match || match.count === 0) {
      const reason = plainElements.has(node.element) ? 'reparentedElement' : 'unmatchedElement';
      return `unstable(${reason}) at node ${node.index}`;
    }
    if (match.frame !== frameOf(node)) return `unstable(movedElement) at node ${node.index}`;
    match.count -= 1;
  }
  return undefined;
}

function readModalSurface(honorModal: RecordedNode[]): Reading {
  const instability = pairInstability(honorModal);
  if (instability) return { kind: 'unknown', reason: instability };
  if (plain.length === honorModal.length) return { kind: 'noExclusion' };
  if (plain[0].element !== honorModal[0].element)
    return { kind: 'unknown', reason: 'rootMismatch' };
  const plainChildren = childrenOf(plain);
  const keptChildren = childrenOf(honorModal);
  const markers = new Map<number, string>();
  let failure = '';

  // Returns the number of surfaces under the node, or undefined when the walk fails.
  function surfaces(honorModalNode: number, plainNode: number): number | undefined {
    const removed = [...plainChildren[plainNode]];
    const kept: Array<[number, number]> = [];
    const listed = countElements(plain, plainChildren[plainNode]);
    const keptListed = countElements(honorModal, keptChildren[honorModalNode]);
    for (const child of keptChildren[honorModalNode]) {
      const element = honorModal[child].element;
      const listedCount = listed.get(element) ?? 0;
      const keptCount = keptListed.get(element) ?? 0;
      if (listedCount >= 2 && keptCount < listedCount) {
        failure = `duplicatedChild at node ${honorModalNode} (kept ${keptCount} of ${listedCount} occurrences of ${element})`;
        return undefined;
      }
      const match = removed.findIndex((position) => plain[position].element === element);
      if (match < 0) {
        failure = `unstable(reparentedElement) at node ${child}`;
        return undefined;
      }
      kept.push([child, removed.splice(match, 1)[0]]);
    }
    let nested = 0;
    for (const [keptChild, plainChild] of kept) {
      const found = surfaces(keptChild, plainChild);
      if (found === undefined) return undefined;
      nested += found;
    }
    if (removed.length === 0 || kept.length === 0) return nested;
    markers.set(
      honorModalNode,
      `[kept ${kept.length} of ${plainChildren[plainNode].length} children]`,
    );
    return nested === 0 ? 1 : nested;
  }

  const found = surfaces(0, 0);
  if (found === undefined) return { kind: 'unknown', reason: failure };
  return found === 0
    ? { kind: 'unknown', reason: 'noSurvivingSurface' }
    : { kind: 'modal', markers };
}

const reading = treeName === 'honorModal' ? readModalSurface(nodes) : undefined;
if (reading?.kind === 'unknown') console.log(`unknown: ${reading.reason}`);
const markers = reading?.kind === 'modal' ? reading.markers : new Map<number, string>();

const depths: number[] = [];
for (const node of nodes) {
  depths[node.index] = node.parentIndex === undefined ? 0 : depths[node.parentIndex] + 1;
  const marker = markers.has(node.index) ? `  ${markers.get(node.index)}` : '';
  console.log(
    `${String(node.index).padStart(4)} ${'  '.repeat(depths[node.index])}${node.type} ${JSON.stringify(node.label)}${marker}`,
  );
}
