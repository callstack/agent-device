// Deterministic Maestro conformance verifier. Runs in normal CI with no Java:
// it replays the checked-in, JVM-generated fixtures against our live engine.
//
//  - Layer 1: parse every corpus flow with our engine, classify it against the
//    upstream parser capture (identical / both-reject / we-reject / mismatch /
//    we-are-lenient), and require every non-identical outcome to be a declared
//    expected divergence.
//  - Layer 2: cross-check each generated semantic vector against the live
//    agent-device constant it mirrors.
//  - Coverage: every command in the support matrix must be exercised by a corpus
//    flow our engine parses, or be explicitly listed as unverified.
//  - Bug classes: the four #1217 regressions each assert against their fixture.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import {
  canonicalizeUpstreamFlow,
  MAESTRO_CONFORMANCE_CONSTANTS,
  parseMaestroConformanceSource,
  SUPPORTED_MAESTRO_COMMAND_NAMES,
  type CanonicalCommand,
} from './harness.ts';
import { LAYER2_REFERENCE_ONLY, UNVERIFIED_COMMANDS } from './expected-divergence.ts';
import { checkFixtureSeal } from './fixture-seal.ts';
import { checkLayer2TreeVector, type Layer2TreeVector } from './layer2-tree.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFORMANCE_DATA_DIR = path.resolve(HERE, '../../../../scripts/maestro-conformance');
export const CORPUS_DIR = path.join(CONFORMANCE_DATA_DIR, 'corpus');
const FIXTURES_DIR = path.join(CONFORMANCE_DATA_DIR, 'fixtures');

export type Classification =
  | 'identical'
  | 'both-reject'
  | 'we-reject'
  | 'mismatch'
  | 'we-are-lenient';

export type FlowResult = {
  id: string;
  file: string;
  upstreamStatus: 'parsed' | 'rejected';
  agentStatus: 'parsed' | 'rejected';
  classification: Classification;
  detail?: string;
};

type Layer1Fixture = {
  flows: Array<{
    id: string;
    file: string;
    status: 'parsed' | 'rejected';
    commands?: Array<{ type: string; fields: Record<string, unknown> }>;
    error?: { class: string; message: string };
  }>;
};

type Layer2Fixture = {
  constants: Array<{ id: string; symbol: string; value: number }>;
  modelDefaults: Array<{ id: string; value: number }>;
  treeVectors: Layer2TreeVector[];
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

const FIXTURE_FILES = ['layer1-parser.json', 'layer2-semantics.json'] as const;

export function loadLayer1(): Layer1Fixture {
  return readJson(path.join(FIXTURES_DIR, 'layer1-parser.json'));
}

export function loadLayer2(): Layer2Fixture {
  return readJson(path.join(FIXTURES_DIR, 'layer2-semantics.json'));
}

export type SealResult = { file: string; sealed: boolean; expected: string; actual?: string };

type CorpusManifest = {
  flows: Array<{
    file: string;
    origin: { kind: 'authored'; note: string } | { kind: 'upstream'; sha256: string };
  }>;
};

/**
 * Recompute each fixture's content seal. This is what makes "generated from
 * upstream" an enforced property rather than a claim in a README: editing a
 * captured command or constant by hand changes the content and fails here.
 */
export function checkFixtureSeals(): SealResult[] {
  return FIXTURE_FILES.map((file) => {
    const parsed = readJson<Record<string, unknown>>(path.join(FIXTURES_DIR, file));
    const { expected, actual } = checkFixtureSeal(parsed);
    return { file, sealed: expected === actual, expected, actual: actual as string | undefined };
  });
}

/** Verify vendored upstream source bytes in normal, Java-free per-PR CI. */
export function checkCorpusSeals(): SealResult[] {
  const manifest = readJson<CorpusManifest>(path.join(CORPUS_DIR, 'manifest.json'));
  return manifest.flows.flatMap((flow) => {
    if (flow.origin.kind !== 'upstream') return [];
    const actual = createHash('sha256')
      .update(fs.readFileSync(path.join(CORPUS_DIR, flow.file)))
      .digest('hex');
    return [
      {
        file: flow.file,
        sealed: actual === flow.origin.sha256,
        expected: flow.origin.sha256,
        actual,
      },
    ];
  });
}

/**
 * Error codes that count as a deliberate parser rejection. Every rejection the
 * Maestro parser raises — unsupported command/option, bad value, and even a YAML
 * syntax error — is wrapped as AppError('INVALID_ARGS'). Anything else (a
 * TypeError, a bug in our own parser) is a crash, not a rejection: rethrow it so
 * it surfaces loudly instead of being laundered into a `we-reject` that a
 * declared divergence would then silently accept.
 */
const AGENT_REJECTION_CODES = new Set(['INVALID_ARGS']);

/** Parse a corpus flow with the live engine. `null` = a clean rejection. */
function agentParseProgram(file: string): ReturnType<typeof parseMaestroConformanceSource> | null {
  const script = fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8');
  try {
    return parseMaestroConformanceSource(script, file);
  } catch (error) {
    if (error instanceof AppError && AGENT_REJECTION_CODES.has(error.code)) return null;
    throw new Error(`Parsing ${file} crashed instead of rejecting cleanly`, { cause: error });
  }
}

function agentParse(file: string): {
  status: 'parsed' | 'rejected';
  commands?: CanonicalCommand[];
} {
  const program = agentParseProgram(file);
  if (!program) return { status: 'rejected' };
  return { status: 'parsed', commands: program.commands };
}

function classifyFlow(fixtureFlow: Layer1Fixture['flows'][number]): FlowResult {
  const agent = agentParse(fixtureFlow.file);
  const upstreamStatus = fixtureFlow.status;
  const base = {
    id: fixtureFlow.id,
    file: fixtureFlow.file,
    upstreamStatus,
    agentStatus: agent.status,
  };

  if (upstreamStatus === 'rejected') {
    return {
      ...base,
      classification: agent.status === 'rejected' ? 'both-reject' : 'we-are-lenient',
    };
  }
  // upstream parsed
  if (agent.status === 'rejected') {
    return { ...base, classification: 'we-reject' };
  }
  const upstream = canonicalizeUpstreamFlow(fixtureFlow.commands ?? []);
  const agentCommands = agent.commands ?? [];
  const upstreamJson = JSON.stringify(upstream);
  const agentJson = JSON.stringify(agentCommands);
  if (upstreamJson === agentJson) return { ...base, classification: 'identical' };
  return {
    ...base,
    classification: 'mismatch',
    detail: `upstream=${upstreamJson}\n  agent   =${agentJson}`,
  };
}

export function classifyAllFlows(): FlowResult[] {
  return loadLayer1().flows.map(classifyFlow);
}

// ---------------------------------------------------------------------------
// Layer 2 cross-check
// ---------------------------------------------------------------------------

/** Generated vector id → the live agent-device constant it must equal. */
const LAYER2_AGENT_CONSTANTS: Record<string, number> = {
  ...MAESTRO_CONFORMANCE_CONSTANTS,
};

export type Layer2Result = {
  id: string;
  upstream: number;
  agent?: number;
  status: 'match' | 'mismatch' | 'reference-only';
};

export function checkLayer2(): Layer2Result[] {
  const fixture = loadLayer2();
  const vectors = [...fixture.constants, ...fixture.modelDefaults];
  const results = vectors.map((vector) => {
    if (LAYER2_REFERENCE_ONLY.has(vector.id)) {
      return { id: vector.id, upstream: vector.value, status: 'reference-only' as const };
    }
    const agent = LAYER2_AGENT_CONSTANTS[vector.id];
    if (agent === undefined) {
      return { id: vector.id, upstream: vector.value, status: 'reference-only' as const };
    }
    return {
      id: vector.id,
      upstream: vector.value,
      agent,
      status: agent === vector.value ? ('match' as const) : ('mismatch' as const),
    };
  });
  for (const vector of fixture.treeVectors) {
    const tree = checkLayer2TreeVector(vector);
    results.push({
      id: vector.id,
      ...tree,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Support-matrix coverage
// ---------------------------------------------------------------------------

export type CoverageResult = { command: string; covered: boolean; unverified: boolean };

/** Which native agent-device command kinds each corpus flow parses to. */
function agentKindsByCorpus(): Set<string> {
  const kinds = new Set<string>();
  for (const flow of loadLayer1().flows) {
    // Rejected flows contribute nothing to coverage; a crash still throws.
    const program = agentParseProgram(flow.file);
    if (program) {
      for (const kind of program.kinds) kinds.add(kind);
    }
  }
  return kinds;
}

export function checkCoverage(): CoverageResult[] {
  const covered = agentKindsByCorpus();
  return SUPPORTED_MAESTRO_COMMAND_NAMES.map((command) => ({
    command,
    covered: covered.has(command),
    unverified: UNVERIFIED_COMMANDS.has(command),
  }));
}

// ---------------------------------------------------------------------------
// Report CLI (dev aid; the enforcing checks live in verify.test.ts)
// ---------------------------------------------------------------------------

function report(): void {
  const flows = classifyAllFlows();
  const byClass = new Map<Classification, FlowResult[]>();
  for (const flow of flows) {
    const group = byClass.get(flow.classification) ?? [];
    group.push(flow);
    byClass.set(flow.classification, group);
  }
  for (const [classification, group] of byClass) {
    console.log(`\n### ${classification} (${group.length})`);
    for (const flow of group) {
      console.log(`  ${flow.id}`);
      if (flow.detail) console.log(`    ${flow.detail}`);
    }
  }
  console.log('\n### layer 2');
  for (const result of checkLayer2()) {
    console.log(
      `  ${result.status.padEnd(14)} ${result.id} upstream=${result.upstream} agent=${result.agent ?? '-'}`,
    );
  }
  console.log('\n### coverage gaps');
  for (const result of checkCoverage()) {
    if (!result.covered && !result.unverified) console.log(`  UNCOVERED ${result.command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  report();
}
