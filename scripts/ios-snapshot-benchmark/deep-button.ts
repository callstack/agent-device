import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DeepButtonEvidence, DeepButtonObservation } from './types.ts';

const INVALID_SHALLOW_COMMAND = 'pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow';
const SAFE_FULL_COMMAND = 'pnpm bench:ios-snapshot:deep-button -- --rule safe-full';
const INVALID_ASSERTION =
  'AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.';

type FixtureNode = { id: string; depth: number; label: string; state?: 'off' | 'on' };

const SURFACE_NODES: FixtureNode[] = [
  { id: 'deep-button-root', depth: 0, label: 'Deep button fixture' },
  { id: 'deep-button-container', depth: 1, label: 'Action container' },
];

function fullNodes(state: 'off' | 'on'): FixtureNode[] {
  return [
    ...SURFACE_NODES,
    { id: 'deep-button-state', depth: 8, label: `Deep button ${state}`, state },
  ];
}

function digest(nodes: FixtureNode[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(nodes)).digest('hex');
}

function observation(state: 'off' | 'on'): DeepButtonObservation {
  const surfaceNodes = SURFACE_NODES;
  const allNodes = fullNodes(state);
  return {
    surfaceDigest: digest(surfaceNodes),
    fullDigest: digest(allNodes),
    state,
    surfaceNodeIds: surfaceNodes.map((node) => node.id),
    fullNodeIds: allNodes.map((node) => node.id),
  };
}

export function deepButtonFixtureEvidence(): DeepButtonEvidence {
  const before = observation('off');
  const after = observation('on');
  return {
    issue: '#1626',
    fixture: 'deep-button-v1',
    changedDescendant: 'deep-button-state',
    invalidShallowRule: {
      command: INVALID_SHALLOW_COMMAND,
      exitCode: 1,
      assertion: INVALID_ASSERTION,
    },
    safeFullRule: {
      command: SAFE_FULL_COMMAND,
      exitCode: 0,
      assertion: 'full observation changed and includes the changed descendant.',
    },
    before: {
      ...before,
    },
    after: {
      ...after,
    },
  };
}

export function assertInvalidShallowRuleFails(): never {
  const before = observation('off');
  const after = observation('on');
  if (before.surfaceDigest === after.surfaceDigest && before.fullDigest !== after.fullDigest) {
    throw new Error(INVALID_ASSERTION);
  }
  throw new Error('AssertionError: fixture did not produce a changed omitted descendant.');
}

export function assertSafeFullRulePasses(): void {
  const evidence = deepButtonFixtureEvidence();
  if (evidence.before.fullDigest === evidence.after.fullDigest) {
    throw new Error('AssertionError: full observation did not record the changed descendant.');
  }
  if (!evidence.after.fullNodeIds.includes(evidence.changedDescendant)) {
    throw new Error('AssertionError: full observation omitted the changed descendant.');
  }
}

function readRule(argv: string[]): 'invalid-shallow' | 'safe-full' {
  if (argv[0] === '--') argv = argv.slice(1);
  const index = argv.indexOf('--rule');
  const rule = argv[index + 1];
  if (rule === 'invalid-shallow' || rule === 'safe-full') return rule;
  throw new Error('Usage: pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow|safe-full');
}

function runDeepButtonRule(argv: string[]): void {
  const rule = readRule(argv);
  if (rule === 'invalid-shallow') assertInvalidShallowRuleFails();
  assertSafeFullRulePasses();
  process.stdout.write('safe-full: changed descendant observed in the full snapshot.\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runDeepButtonRule(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
