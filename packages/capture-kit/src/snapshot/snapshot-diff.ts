import type { SnapshotDiffLine, SnapshotDiffSummary } from '@agent-device/contracts/capture';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildSnapshotDisplayLines,
  displayLabel,
  formatRole,
  formatSnapshotLine,
  stateMarkers,
} from './snapshot-lines.ts';

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
  // The states the rendered line prints are the states the key compares, from one function, so a
  // fact the diff weighs is always visible in the line it prints.
  const statePart = stateMarkers(node).join(',');
  const hittablePart = node.hittable === true ? 'hittable' : 'not-hittable';
  const depthPart = String(depthOverride ?? node.depth ?? 0);
  // The rendered line carries the actions list, so the comparable key has to as
  // well: otherwise an action-only change diffs as 'unchanged' while its text
  // silently differs from the baseline's. JSON-encoded because the names are
  // app-authored and may contain the field separator.
  const actionsPart = node.actions ? JSON.stringify(node.actions) : '';
  return [depthPart, role, textPart, statePart, hittablePart, actionsPart].join('|');
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
  // Myers' first snake takes the unchanged leading lines anyway, so they skip the search. Trailing
  // lines are not trimmed: that would change which of several minimal diffs is printed.
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < current.length &&
    previous[prefix]!.comparable === current[prefix]!.comparable
  ) {
    prefix += 1;
  }
  return [
    ...current.slice(0, prefix).map((line): SnapshotDiffLine => ({
      kind: 'unchanged',
      text: line.text,
    })),
    ...diffMiddleMyers(previous.slice(prefix), current.slice(prefix)),
  ];
}

/**
 * Myers' greedy search. `trace[d]` keeps only the diagonals step `d` can read, `k` in
 * `[-d - 1, d + 1]`, at index `k + d + 1`, so the trace holds O(D^2) integers rather than D maps.
 */
function diffMiddleMyers(
  previous: SnapshotComparableLine[],
  current: SnapshotComparableLine[],
): SnapshotDiffLine[] {
  const n = previous.length;
  const m = current.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const read = (diagonal: number) => v[offset + diagonal]!;
      const start = shouldGoDown(read, k, d) ? read(k + 1) : read(k - 1) + 1;
      const x = followSnake(previous, current, start, start - k);
      v[offset + k] = x;
      if (x >= n && x - k >= m) {
        return backtrackMyers(trace, previous, current, n, m);
      }
    }
  }

  return [];
}

function backtrackMyers(
  trace: Int32Array[],
  previous: SnapshotComparableLine[],
  current: SnapshotComparableLine[],
  n: number,
  m: number,
): SnapshotDiffLine[] {
  const lines: SnapshotDiffLine[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const step = trace[d]!;
    const at = (diagonal: number) => step[diagonal + d + 1]!;
    const k = x - y;
    const prevK = shouldGoDown(at, k, d) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;

    for (; x > prevX && y > prevY; x -= 1, y -= 1) {
      lines.push({ kind: 'unchanged', text: current[y - 1]!.text });
    }
    if (d === 0) break;
    lines.push(x === prevX ? addedLine(current[prevY]!) : removedLine(previous[prevX]!));
    x = prevX;
    y = prevY;
  }

  lines.reverse();
  return lines;
}

function shouldGoDown(read: (diagonal: number) => number, k: number, d: number): boolean {
  return k === -d || (k !== d && read(k - 1) < read(k + 1));
}

/** Advances along matching lines from `(x, y)` and returns the `x` where the match ends. */
function followSnake(
  previous: SnapshotComparableLine[],
  current: SnapshotComparableLine[],
  x: number,
  y: number,
): number {
  while (x < previous.length && y < current.length) {
    if (previous[x]!.comparable !== current[y]!.comparable) break;
    x += 1;
    y += 1;
  }
  return x;
}

function addedLine(line: SnapshotComparableLine): SnapshotDiffLine {
  return { kind: 'added', text: line.text, ...(line.ref ? { ref: line.ref } : {}) };
}

function removedLine(line: SnapshotComparableLine): SnapshotDiffLine {
  return { kind: 'removed', text: line.text };
}
