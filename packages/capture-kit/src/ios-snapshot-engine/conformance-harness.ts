import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IosSnapshotAcquisition } from '@agent-device/contracts/ios-snapshot';
import { createIosSnapshotRequest, deriveIosCaptureHint } from '../ios-snapshot-planning.ts';
import { IosSnapshotEngineError, presentIosSnapshot } from './index.ts';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const SWIFT_PACKAGE_PATH = path.join(REPO_ROOT, 'apple', 'snapshot-presentation');
const SWIFT_PRODUCT = 'snapshot-presentation-conformance';
export const SWIFT_RUN_TIMEOUT_MS = 60_000;

let swiftHarnessExecutable: string | undefined;

type DifferentialCase = Readonly<{
  name: string;
  projection: 'regular' | 'raw';
  interactiveOnly: false;
  depth: number | null;
  scope: string | null;
  foldPolicy: 'cursor-projected' | 'plain-viewport';
  viewport: Rect;
  nodes: readonly RawSnapshotNode[];
}>;

type DifferentialOutcome = Readonly<{
  name?: string;
  outcome: 'success' | 'failure';
  nodes: readonly CanonicalNode[];
  error?: Readonly<{ code: string; reason: string }>;
}>;

type CanonicalNode = Readonly<{
  index: number;
  type: string | null;
  label: string | null;
  rect: Rect | null;
  depth: number | null;
  parentIndex: number | null;
  hittable: boolean;
  hiddenContentAbove: boolean;
  hiddenContentBelow: boolean;
}>;

type DifferentialMismatch = Readonly<{
  case: DifferentialCase;
  swift: unknown;
  typescript: unknown;
}>;

export function swiftToolchainAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  /* c8 ignore start */
  try {
    execFileSync('swift', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
  /* c8 ignore stop */
}

/* c8 ignore start */
export function compareDifferentialCases(
  cases: readonly DifferentialCase[],
): DifferentialMismatch | undefined {
  const swiftCases = runSwiftCases(cases);
  for (const testCase of cases) {
    const swift = swiftCases.find((entry) => entry.name === testCase.name);
    const typescript = runTypeScriptCase(testCase);
    const normalizedSwift = swift ? withoutName(swift) : undefined;
    if (!normalizedSwift || JSON.stringify(normalizedSwift) !== JSON.stringify(typescript)) {
      return { case: testCase, swift: normalizedSwift, typescript };
    }
  }
  return undefined;
}
/* c8 ignore stop */

/* c8 ignore start */
function runSwiftCases(cases: readonly DifferentialCase[]): DifferentialOutcome[] {
  const stdout = execFileSync(swiftConformanceExecutable(), [], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ cases: cases.map(prepareDifferentialAcquisition) }),
    timeout: SWIFT_RUN_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    cases: Array<{
      name: string;
      outcome: 'success' | 'failure';
      nodes?: RawSnapshotNode[];
      error?: { code: string; reason: string };
    }>;
  };
  return parsed.cases.map((entry) => ({
    name: entry.name,
    outcome: entry.outcome,
    nodes: canonicalNodes(entry.nodes ?? []),
    ...(entry.error ? { error: entry.error } : {}),
  }));
}
/* c8 ignore stop */

/* c8 ignore start */
function swiftConformanceExecutable(): string {
  if (swiftHarnessExecutable) return swiftHarnessExecutable;
  execFileSync('swift', ['build', '--package-path', SWIFT_PACKAGE_PATH], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    timeout: SWIFT_RUN_TIMEOUT_MS,
  });
  const binPath = execFileSync(
    'swift',
    ['build', '--show-bin-path', '--package-path', SWIFT_PACKAGE_PATH],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: SWIFT_RUN_TIMEOUT_MS },
  ).trim();
  swiftHarnessExecutable = path.join(binPath, SWIFT_PRODUCT);
  return swiftHarnessExecutable;
}
/* c8 ignore stop */

function prepareDifferentialAcquisition(testCase: DifferentialCase): DifferentialCase {
  if (testCase.projection !== 'raw' || testCase.scope !== null || testCase.depth === null) {
    return testCase;
  }
  return {
    ...testCase,
    nodes: testCase.nodes.filter((node) => (node.depth ?? 0) <= testCase.depth!),
  };
}

/* c8 ignore start */
function withoutName(outcome: DifferentialOutcome): Omit<DifferentialOutcome, 'name'> {
  const { name: _name, ...normalized } = outcome;
  return normalized;
}
/* c8 ignore stop */

export function runTypeScriptCase(testCase: DifferentialCase): DifferentialOutcome {
  const acquisitionInput = prepareDifferentialAcquisition(testCase);
  const request = createIosSnapshotRequest({
    projection: testCase.projection,
    interactiveOnly: testCase.interactiveOnly,
    depth: testCase.depth,
    scope: testCase.scope,
  });
  const acquisition: IosSnapshotAcquisition = {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    hint: { ...deriveIosCaptureHint(request), acquisitionIntent: 'full' },
    nodes: acquisitionInput.nodes,
    truncated: false,
    viewport: { kind: 'reported', rect: testCase.viewport },
    lineage: { targetId: 'differential-target', generation: 'differential-generation' },
    residue: [],
  };
  try {
    const result = presentIosSnapshot({ stage: 'acquired', acquisition }, request, {
      foldPolicy: testCase.foldPolicy,
    });
    return { outcome: 'success', nodes: canonicalNodes(result.nodes) };
  } catch (error) {
    if (!(error instanceof IosSnapshotEngineError)) throw error;
    return {
      outcome: 'failure',
      nodes: [],
      error: { code: error.code, reason: error.reason },
    };
  }
}

export function canonicalNodes(nodes: readonly RawSnapshotNode[]): CanonicalNode[] {
  return nodes.map((node) => ({
    index: node.index,
    type: node.type ?? null,
    label: node.label ?? null,
    rect: node.rect ? canonicalRect(node.rect) : null,
    depth: node.depth ?? null,
    parentIndex: node.parentIndex ?? null,
    hittable: node.hittable === true,
    hiddenContentAbove: node.hiddenContentAbove === true,
    hiddenContentBelow: node.hiddenContentBelow === true,
  }));
}

function canonicalRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function writeDifferentialFailureArtifact(input: {
  testCase: DifferentialCase;
  seed: number;
  counterexamplePath: string;
}): { directory: string; casePath: string; replayCommand: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-snapshot-fuzz-'));
  const casePath = path.join(directory, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify({ cases: [input.testCase] }, null, 2) + '\n');
  const replayCommand = [
    'node --experimental-strip-types',
    'packages/capture-kit/src/ios-snapshot-engine/replay.ts',
    JSON.stringify(casePath),
  ].join(' ');
  fs.writeFileSync(
    path.join(directory, 'replay-command.txt'),
    replayCommand + '\nseed=' + String(input.seed) + '\npath=' + input.counterexamplePath + '\n',
  );
  return { directory, casePath, replayCommand };
}
