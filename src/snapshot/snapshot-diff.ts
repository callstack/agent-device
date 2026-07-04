import type { SnapshotNode } from '../kernel/snapshot.ts';
import {
  buildSnapshotDisplayLines,
  displayLabel,
  formatRole,
  formatSnapshotLine,
} from './snapshot-lines.ts';

export type SnapshotDiffLine = {
  kind: 'added' | 'removed' | 'unchanged';
  text: string;
  /**
   * Plain ref body (`e12`) of the CURRENT-tree node behind an added line.
   * Only populated with `withRefs` (interaction `--settle`, #1101) so the
   * `diff` command's wire shape stays byte-identical. Removed/unchanged lines
   * never carry it: a removed line's ref names a node of the replaced tree.
   */
  ref?: string;
};

export type SnapshotDiffSummary = {
  additions: number;
  removals: number;
  unchanged: number;
};

export type SnapshotDiffResult = {
  summary: SnapshotDiffSummary;
  lines: SnapshotDiffLine[];
};

type SnapshotDiffOptions = {
  flatten?: boolean;
  /** Attach the current-tree node ref to added lines (see SnapshotDiffLine.ref). */
  withRefs?: boolean;
};

type SnapshotComparableLine = {
  text: string;
  comparable: string;
  ref?: string;
};

function snapshotNodeToComparableLine(node: SnapshotNode, depthOverride?: number): string {
  const role = formatRole(node.type ?? 'Element');
  const textPart = displayLabel(node, role);
  const enabledPart = node.enabled === false ? 'disabled' : 'enabled';
  const selectedPart = node.selected === true ? 'selected' : 'unselected';
  const hittablePart = node.hittable === true ? 'hittable' : 'not-hittable';
  const depthPart = String(depthOverride ?? node.depth ?? 0);
  return [depthPart, role, textPart, enabledPart, selectedPart, hittablePart].join('|');
}

export function buildSnapshotDiff(
  previousNodes: SnapshotNode[],
  currentNodes: SnapshotNode[],
  options: SnapshotDiffOptions = {},
): SnapshotDiffResult {
  const previous = snapshotNodesToLines(previousNodes, options);
  const current = snapshotNodesToLines(currentNodes, options);
  const lines = diffComparableLinesMyers(previous, current);
  const summary: SnapshotDiffSummary = { additions: 0, removals: 0, unchanged: 0 };
  for (const line of lines) {
    if (line.kind === 'added') summary.additions += 1;
    if (line.kind === 'removed') summary.removals += 1;
    if (line.kind === 'unchanged') summary.unchanged += 1;
  }
  return { summary, lines };
}

export function countSnapshotComparableLines(
  nodes: SnapshotNode[],
  options: SnapshotDiffOptions = {},
): number {
  return snapshotNodesToLines(nodes, options).length;
}

function snapshotNodesToLines(
  nodes: SnapshotNode[],
  options: SnapshotDiffOptions,
): SnapshotComparableLine[] {
  if (options.flatten) {
    return nodes.map((node) => ({
      text: formatSnapshotLine(node, 0, false),
      comparable: snapshotNodeToComparableLine(node, 0),
      ...(options.withRefs && node.ref ? { ref: node.ref } : {}),
    }));
  }
  return buildSnapshotDisplayLines(nodes).map((line) => ({
    text: line.text,
    comparable: snapshotNodeToComparableLine(line.node, line.depth),
    ...(options.withRefs && line.node.ref ? { ref: line.node.ref } : {}),
  }));
}

function diffComparableLinesMyers(
  previous: SnapshotComparableLine[],
  current: SnapshotComparableLine[],
): SnapshotDiffLine[] {
  // Myers diff is efficient for normal UI snapshots; very large trees may still be expensive.
  const n = previous.length;
  const m = current.length;
  const max = n + m;
  const v = new Map<number, number>();
  const trace: Array<Map<number, number>> = [];
  v.set(1, 0);

  for (let d = 0; d <= max; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const goDown = shouldGoDown(v, k, d);
      let x = goDown ? getV(v, k + 1) : getV(v, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && previous[x]!.comparable === current[y]!.comparable) {
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        return backtrackMyers(trace, previous, current, n, m);
      }
    }
  }

  return [];
}

function backtrackMyers(
  trace: Array<Map<number, number>>,
  previous: SnapshotComparableLine[],
  current: SnapshotComparableLine[],
  n: number,
  m: number,
): SnapshotDiffLine[] {
  const lines: SnapshotDiffLine[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const goDown = shouldGoDown(v, k, d);
    const prevK = goDown ? k + 1 : k - 1;
    const prevX = getV(v, prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      lines.push({ kind: 'unchanged', text: current[y - 1]!.text });
      x -= 1;
      y -= 1;
    }

    if (d === 0) break;

    if (x === prevX) {
      const added = current[prevY]!;
      lines.push({ kind: 'added', text: added.text, ...(added.ref ? { ref: added.ref } : {}) });
      y = prevY;
    } else {
      lines.push({ kind: 'removed', text: previous[prevX]!.text });
      x = prevX;
    }
  }

  lines.reverse();
  return lines;
}

function shouldGoDown(v: Map<number, number>, k: number, d: number): boolean {
  return k === -d || (k !== d && getV(v, k - 1) < getV(v, k + 1));
}

function getV(v: Map<number, number>, k: number): number {
  return v.get(k) ?? 0;
}
