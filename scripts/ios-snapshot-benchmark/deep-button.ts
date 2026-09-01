import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_FILENAME,
  materializeNodes,
  readDeepButtonFixtureArtifact,
  type DeepButtonArtifact,
} from './deep-button-artifact.ts';
import type { DeepButtonEvidence, DeepButtonObservation } from './types.ts';

const INVALID_SHALLOW_COMMAND = 'pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow';
const SAFE_FULL_COMMAND = 'pnpm bench:ios-snapshot:deep-button -- --rule safe-full';
const INVALID_ASSERTION =
  'AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.';

export { readDeepButtonFixtureArtifact } from './deep-button-artifact.ts';

export function deepButtonFixtureEvidence(): DeepButtonEvidence {
  const artifact = readDeepButtonFixtureArtifact();
  return {
    issue: '#1626',
    fixture: 'deep-button-v1',
    artifact: ARTIFACT_FILENAME,
    depth: artifact.depth,
    changedDescendant: artifact.changedDescendant,
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
    before: observation(artifact, artifact.before),
    after: observation(artifact, artifact.after),
  };
}

export function assertInvalidShallowRuleFails(): never {
  const evidence = deepButtonFixtureEvidence();
  if (
    evidence.before.surfaceDigest === evidence.after.surfaceDigest &&
    evidence.before.fullDigest !== evidence.after.fullDigest &&
    !evidence.after.surfaceNodeIds.includes(evidence.changedDescendant) &&
    evidence.after.fullNodeIds.includes(evidence.changedDescendant)
  ) {
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

function observation(
  artifact: DeepButtonArtifact,
  source: DeepButtonArtifact['before'],
): DeepButtonObservation {
  const surfaceNodes = materializeNodes(artifact.nodes, source.shallowNodeIds, source.changedNode);
  const fullNodes = materializeNodes(artifact.nodes, source.fullNodeIds, source.changedNode);
  return {
    depth: artifact.depth,
    surfaceDigest: digest(surfaceNodes),
    fullDigest: digest(fullNodes),
    state: source.state,
    surfaceNodeIds: source.shallowNodeIds,
    fullNodeIds: source.fullNodeIds,
  };
}

function digest(nodes: DeepButtonArtifact['nodes']): string {
  return crypto.createHash('sha256').update(JSON.stringify(nodes)).digest('hex');
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
