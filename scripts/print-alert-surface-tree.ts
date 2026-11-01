// Prints what ModalSurface reads from an alert surface corpus recording, then one of its trees, one
// node per line, so a contributor can write its `expectModalScope` by hand.
// See apple/snapshot-presentation/Tests/AlertSurfaceCorpus/README.md.
import fs from 'node:fs';

type Rect = {
  infinite?: boolean;
  nonFinite?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};
type RecordedNode = {
  index: number;
  parentIndex?: number;
  element: string;
  type: string;
  label: string;
  rect: Rect;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [file, treeName = 'honorModal'] = process.argv.slice(2);
if (!file || (treeName !== 'honorModal' && treeName !== 'plain')) {
  fail('Usage: pnpm print:alert-surface <recording.json> [honorModal|plain]');
}
let recording: Record<string, unknown>;
try {
  recording = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  fail(`${file}: ${(error as Error).message}`);
}
if (recording.format !== 2) {
  fail(`${file}: format ${JSON.stringify(recording.format)} is not 2. Capture it again.`);
}
const plain = recordedTree('plain');
const honorModal = recordedTree('honorModal');

// The checks RecordedAlertSurface.load makes: each node decodes, its index is its position, and its
// parent comes before it. An empty honor-modal tree is left to the reading, which names it.
function recordedTree(name: string): RecordedNode[] {
  const tree = recording[name];
  if (!Array.isArray(tree) || (tree.length === 0 && name === 'plain')) {
    fail(`${file}: "${name}" is not a tree`);
  }
  tree.forEach((node, position) => {
    if (node.parentIndex === null) delete node.parentIndex;
    const parent = node.parentIndex;
    const isValid =
      node.index === position &&
      (parent === undefined
        ? position === 0
        : Number.isInteger(parent) && parent >= 0 && parent < position) &&
      ['element', 'type', 'identifier', 'label'].every((key) => typeof node[key] === 'string') &&
      isRect(node.rect);
    if (!isValid) fail(`${file}: "${name}" node ${position} does not load. Capture it again.`);
  });
  return tree;
}

function isRect(rect: Record<string, unknown> | null): boolean {
  if (typeof rect !== 'object' || rect === null) return false;
  const flags = [rect.infinite, rect.nonFinite];
  if (flags.some((flag) => flag != null && typeof flag !== 'boolean')) return false;
  return (
    flags.includes(true) ||
    ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number')
  );
}

// CGRect equality compares rects after it makes their sizes positive.
function frameKey({ infinite, nonFinite, x, y, width, height }: Rect): string {
  if (infinite) return 'infinite';
  if (nonFinite) return 'nonFinite';
  const origin = [width < 0 ? x + width : x, height < 0 ? y + height : y];
  return [...origin, Math.abs(width), Math.abs(height)].join();
}

// The rest ports ModalScopePair.pair, ModalSurface.read and its children(of:) in the same order,
// so the printed reading is the one the replay checks. The replay passes the honor-modal tree as its
// own confirming read and states that no read was truncated.
function pairInstability(): string | undefined {
  const keyOf = (tree: RecordedNode[], node: RecordedNode) =>
    JSON.stringify([
      node.element,
      node.parentIndex === undefined ? null : tree[node.parentIndex].element,
    ]);
  const unmatched = new Map<string, { frame: string; count: number }>();
  for (const node of plain) {
    const key = keyOf(plain, node);
    unmatched.set(key, { frame: frameKey(node.rect), count: (unmatched.get(key)?.count ?? 0) + 1 });
  }
  const plainElements = new Set(plain.map((node) => node.element));
  for (const node of honorModal) {
    const match = unmatched.get(keyOf(honorModal, node));
    if (!match || match.count === 0) {
      const reason = plainElements.has(node.element) ? 'reparentedElement' : 'unmatchedElement';
      return `unknown(unstable(${reason})): node ${node.index}`;
    }
    if (match.frame !== frameKey(node.rect))
      return `unknown(unstable(movedElement)): node ${node.index}`;
    match.count -= 1;
  }
  return undefined;
}

// A node's parent is its nearest listed ancestor with the parent element.
function childrenOf(tree: RecordedNode[]): number[][] | undefined {
  const children = tree.map((): number[] => []);
  const ancestors: number[] = [];
  for (const node of tree) {
    if (node.parentIndex !== undefined) {
      const parentElement = tree[node.parentIndex].element;
      while (ancestors.length > 0 && tree[ancestors.at(-1)!].element !== parentElement) {
        ancestors.pop();
      }
      if (ancestors.length === 0) return undefined;
      children[ancestors.at(-1)!].push(node.index);
    } else if (node.index !== 0) {
      return undefined;
    }
    ancestors.push(node.index);
  }
  return children;
}

function countElements(tree: RecordedNode[], positions: number[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const position of positions) {
    counts.set(tree[position].element, (counts.get(tree[position].element) ?? 0) + 1);
  }
  return counts;
}

const markers = new Map<number, string>();
function readModalSurface(): string {
  const instability = pairInstability();
  if (instability) return instability;
  if (plain.length === honorModal.length) return 'noExclusion';
  if (honorModal.length === 0) return 'unknown(rootMismatch): the honor-modal tree is empty';
  if (plain[0].element !== honorModal[0].element) return 'unknown(rootMismatch)';
  const plainChildren = childrenOf(plain);
  const keptChildren = childrenOf(honorModal);
  if (!plainChildren || !keptChildren) return 'unknown(unorderedRead)';
  let failure = '';

  // The number of surfaces under the node, or undefined when the walk fails.
  function surfaces(honorModalNode: number, plainNode: number): number | undefined {
    const removed = [...plainChildren![plainNode]];
    const kept: Array<[number, number]> = [];
    const listed = countElements(plain, plainChildren![plainNode]);
    const keptListed = countElements(honorModal, keptChildren![honorModalNode]);
    for (const child of keptChildren![honorModalNode]) {
      const element = honorModal[child].element;
      const listedCount = listed.get(element) ?? 0;
      const keptCount = keptListed.get(element) ?? 0;
      if (listedCount >= 2 && keptCount < listedCount) {
        failure = `unknown(duplicatedChild): node ${honorModalNode} kept ${keptCount} of ${listedCount} children with element id ${element}`;
        return undefined;
      }
      const match = removed.findIndex((position) => plain[position].element === element);
      if (match < 0) {
        failure = `unknown(unstable(reparentedElement)): node ${child}`;
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
      `[kept ${kept.length} of ${plainChildren![plainNode].length} children]`,
    );
    return nested === 0 ? 1 : nested;
  }

  const found = surfaces(0, 0);
  if (found === undefined) return failure;
  return found === 0 ? 'unknown(noSurvivingSurface)' : 'modal';
}

const reading = readModalSurface();
console.log(`ModalSurface reads (the rule's answer, not ground truth): ${reading}`);
if (reading !== 'modal' || treeName === 'plain') markers.clear();

const depths: number[] = [];
for (const node of treeName === 'plain' ? plain : honorModal) {
  depths[node.index] = node.parentIndex === undefined ? 0 : depths[node.parentIndex] + 1;
  const marker = markers.has(node.index) ? `  ${markers.get(node.index)}` : '';
  console.log(
    `${String(node.index).padStart(4)} ${'  '.repeat(depths[node.index])}${node.type} ${JSON.stringify(node.label)}${marker}`,
  );
}
