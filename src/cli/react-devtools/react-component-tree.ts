import { AppError } from '@agent-device/kernel/errors';
import { printable } from './react-devtools-text.ts';

/** `[id, name, elementType, parentId, ownerId, key]` for every mounted component. */
type RawTreeNode = [number, string, number, number, number, string | null];

/** The component tree as the in-app runtime exports it from `tree()`. */
export type RawComponentTree = {
  nodes: RawTreeNode[];
  /** Child order a reorder recorded, by parent id; other children keep their mount order. */
  order: Record<string, number[]>;
  /** `[errors, warnings]` the component logged while rendering, by id. */
  logs: Record<string, [number, number]>;
  /**
   * Whether the backend attributes console errors and warnings to components from app start.
   * Older backends attribute them partly or not at all, so missing counts prove nothing.
   */
  logsTracked: boolean;
};

export type TreeNode = {
  id: number;
  name: string;
  elementType: number;
  key: string | null;
  ownerId: number;
  parent?: TreeNode;
  children: TreeNode[];
  errors: number;
  warnings: number;
};

export type ComponentTree = {
  roots: TreeNode[];
  byId: Map<number, TreeNode>;
  logsTracked: boolean;
};

const ELEMENT_CLASS = 1;
const ELEMENT_FORWARD_REF = 6;
const ELEMENT_MEMO = 8;

const TYPE_WRAPPER = /^(?:Memo|ForwardRef)\((.+)\)$/;

/** `Memo(Row)` reads as `Row`: the element type already says it is memoized. */
export function componentName(displayName: string): string {
  let name = displayName;
  for (let match = TYPE_WRAPPER.exec(name); match; match = TYPE_WRAPPER.exec(name)) {
    name = match[1]!;
  }
  return name;
}

export function buildComponentTree(raw: RawComponentTree): ComponentTree {
  const byId = new Map<number, TreeNode>();
  for (const [id, displayName, elementType, , ownerId, key] of raw.nodes) {
    const [errors, warnings] = raw.logs[String(id)] ?? [0, 0];
    const name = componentName(printable(displayName));
    byId.set(id, {
      id,
      name,
      elementType,
      key: key === null ? null : printable(key),
      ownerId,
      children: [],
      errors,
      warnings,
    });
  }
  const roots: TreeNode[] = [];
  for (const [id, , , parentId] of raw.nodes) {
    const node = byId.get(id)!;
    const parent = byId.get(parentId);
    if (!parent) {
      roots.push(node);
      continue;
    }
    node.parent = parent;
    parent.children.push(node);
  }
  for (const [parentId, childIds] of Object.entries(raw.order)) {
    const parent = byId.get(Number(parentId));
    if (!parent) continue;
    const position = new Map(childIds.map((id, index) => [id, index]));
    parent.children.sort(
      (a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity),
    );
  }
  return { roots, byId, logsTracked: raw.logsTracked };
}

export function componentRef(node: { id: number }): string {
  return `@c${node.id}`;
}

export function kindLabel(elementType: number): string {
  if (elementType === ELEMENT_MEMO) return ' [memo]';
  if (elementType === ELEMENT_CLASS) return ' [class]';
  if (elementType === ELEMENT_FORWARD_REF) return ' [forwardRef]';
  return '';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function logSummary(node: TreeNode): string {
  const parts = [];
  if (node.errors > 0) parts.push(plural(node.errors, 'error'));
  if (node.warnings > 0) parts.push(plural(node.warnings, 'warning'));
  return parts.join(', ');
}

function nodeLabel(node: TreeNode): string {
  const key = node.key === null ? '' : ` key=${node.key}`;
  const logs = logSummary(node);
  return `${componentRef(node)} ${node.name}${kindLabel(node.elementType)}${key}${logs ? ` (${logs})` : ''}`;
}

function descendantCount(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + descendantCount(child), 0);
}

/** A run of single-child wrappers, such as providers, reads as one line. */
const CHAIN_HEAD = 2;
const CHAIN_TAIL = 2;

function chainOf(node: TreeNode): TreeNode[] {
  const chain = [node];
  for (let last = node; last.children.length === 1; last = last.children[0]!) {
    chain.push(last.children[0]!);
  }
  return chain;
}

function chainLabel(chain: TreeNode[]): string {
  if (chain.length <= CHAIN_HEAD + CHAIN_TAIL + 1) return chain.map(nodeLabel).join(' > ');
  const hidden = chain.length - CHAIN_HEAD - CHAIN_TAIL;
  return [
    ...chain.slice(0, CHAIN_HEAD).map(nodeLabel),
    `(${hidden} wrappers)`,
    ...chain.slice(-CHAIN_TAIL).map(nodeLabel),
  ].join(' > ');
}

/** Siblings that collapse into one line: this many or more, all of one shape. */
const MIN_COLLAPSED_RUN = 3;

/**
 * Numbers each subtree by its shape: names, element types, and logged problems, all the way down.
 * Two subtrees with one number print the same, apart from refs and keys.
 */
class SubtreeShapes {
  readonly #ids = new Map<string, number>();
  readonly #byNode = new Map<TreeNode, number>();

  of(node: TreeNode): number {
    const known = this.#byNode.get(node);
    if (known !== undefined) return known;
    const signature = [
      node.name,
      node.elementType,
      node.errors,
      node.warnings,
      ...node.children.map((child) => this.of(child)),
    ].join('\0');
    let id = this.#ids.get(signature);
    if (id === undefined) {
      id = this.#ids.size;
      this.#ids.set(signature, id);
    }
    this.#byNode.set(node, id);
    return id;
  }
}

/**
 * Consecutive siblings of one shape, such as list rows, read as one line. Screens of one navigator
 * share a name but not a shape, so the focused one stays open, and a row that logged a problem
 * its neighbours did not stays on its own line.
 */
function siblingRuns(children: TreeNode[], shapes: SubtreeShapes): TreeNode[][] {
  const runs: TreeNode[][] = [];
  for (const child of children) {
    const run = runs.at(-1);
    const first = run?.[0];
    if (first && shapes.of(first) === shapes.of(child)) run.push(child);
    else runs.push([child]);
  }
  return runs.flatMap((run) =>
    run.length >= MIN_COLLAPSED_RUN ? [run] : run.map((child) => [child]),
  );
}

export type TreeView = { lines: string[]; shown: number; total: number };

/**
 * Renders `roots` as indented lines, `depth` levels deep and at most `limit` lines long. Wrapper
 * chains and sibling runs collapse so the lines go to components that branch.
 */
export function renderTree(roots: TreeNode[], depth: number, limit: number): TreeView {
  const lines: string[] = [];
  const shapes = new SubtreeShapes();
  let shown = 0;
  const total = roots.reduce((sum, root) => sum + 1 + descendantCount(root), 0);
  const visit = (node: TreeNode, level: number): void => {
    if (lines.length >= limit) return;
    const chain = chainOf(node);
    const tail = chain.at(-1)!;
    shown += chain.length;
    const indent = '  '.repeat(level);
    if (level + 1 >= depth && tail.children.length > 0) {
      lines.push(`${indent}${chainLabel(chain)} (+${descendantCount(tail)} below)`);
      return;
    }
    lines.push(`${indent}${chainLabel(chain)}`);
    for (const run of siblingRuns(tail.children, shapes)) {
      if (lines.length >= limit) return;
      if (run.length === 1) {
        visit(run[0]!, level + 1);
        continue;
      }
      shown += run.length;
      const below = run.reduce((sum, sibling) => sum + descendantCount(sibling), 0);
      lines.push(
        `${'  '.repeat(level + 1)}${nodeLabel(run[0]!)} x${run.length}${below > 0 ? ` (+${below} below)` : ''}`,
      );
    }
  };
  for (const root of roots) visit(root, 0);
  return { lines, shown, total };
}

function ownerChain(tree: ComponentTree, node: TreeNode, length: number): string[] {
  const owners: string[] = [];
  for (
    let owner = tree.byId.get(node.ownerId);
    owner && owners.length < length;
    owner = tree.byId.get(owner.ownerId)
  ) {
    owners.push(owner.name);
  }
  return owners;
}

export function matchLine(tree: ComponentTree, node: TreeNode): string {
  const owners = ownerChain(tree, node, 2);
  return `${nodeLabel(node)}${owners.length > 0 ? ` in ${owners.join(' < ')}` : ''}`;
}

/** Components whose name contains `query`, ignoring case, or equals it exactly with `exact`. */
export function findNodes(tree: ComponentTree, query: string, exact: boolean): TreeNode[] {
  const needle = query.toLowerCase();
  return [...tree.byId.values()].filter((node) =>
    exact ? node.name === query : node.name.toLowerCase().includes(needle),
  );
}

const REF_PATTERN = /^@c(\d+)$/;

/** The element id of an `@c<id>` ref, or undefined when `target` is a component name. */
export function parseRef(target: string): number | undefined {
  const match = REF_PATTERN.exec(target);
  return match ? Number(match[1]) : undefined;
}

const AMBIGUOUS_LISTED = 5;

/** The one mounted component a ref or a name selects; a name shared by several fails closed. */
export function resolveNode(tree: ComponentTree, target: string): TreeNode {
  const id = parseRef(target);
  if (id !== undefined) {
    const node = tree.byId.get(id);
    if (!node) {
      throw new AppError('COMMAND_FAILED', `No mounted component has ref ${target}.`, {
        reason: 'element-not-found',
        hint: 'Refs change when components remount or the app reloads; run react-devtools find or tree again.',
      });
    }
    return node;
  }
  const exact = findNodes(tree, target, true);
  const lowered = target.toLowerCase();
  const matches =
    exact.length > 0
      ? exact
      : [...tree.byId.values()].filter((node) => node.name.toLowerCase() === lowered);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new AppError('COMMAND_FAILED', `No mounted component is named ${target}.`, {
      hint: 'Run react-devtools find <part of the name> to search.',
    });
  }
  const listed = matches.slice(0, AMBIGUOUS_LISTED).map(componentRef).join(', ');
  const more =
    matches.length > AMBIGUOUS_LISTED ? ` and ${matches.length - AMBIGUOUS_LISTED} more` : '';
  throw new AppError(
    'INVALID_ARGS',
    `${matches.length} mounted components are named ${target}: ${listed}${more}.`,
    { hint: `Pick one by ref, or run react-devtools find ${target} --exact to list them.` },
  );
}
