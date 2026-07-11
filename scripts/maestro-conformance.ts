import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAgentCase, normalizeUpstreamFixture } from './maestro-conformance-model.ts';
import type {
  NormalizedCase,
  NormalizedFixture,
  RawCase,
  RawCommand,
  RawFixture,
  UpstreamArtifact,
  UpstreamPin,
  UpstreamSource,
} from './maestro-conformance-types.ts';
import { readRequiredRecord } from './maestro-conformance-values.ts';

export const MAESTRO_CONFORMANCE_FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'maestro-conformance-fixtures',
);
export const MAESTRO_CONFORMANCE_RAW_FIXTURE = 'upstream-maestro-2.5.1.json';
export const MAESTRO_CONFORMANCE_NORMALIZED_FIXTURE = 'normalized-maestro-2.5.1.json';
const PINNED_UPSTREAM = {
  project: 'mobile-dev-inc/Maestro',
  version: '2.5.1',
  tag: 'v2.5.1',
  commit: 'a4c7c95f5ba1884858f7e35efa6b8e0165db9448',
} as const;

export type ConformanceCheckResult = {
  upstream: UpstreamPin;
  cases: NormalizedCase[];
};

export function checkConformance(
  options: {
    fixtureDirectory?: string;
  } = {},
): ConformanceCheckResult {
  const fixtureDirectory = options.fixtureDirectory ?? MAESTRO_CONFORMANCE_FIXTURE_DIRECTORY;
  const raw = readRawFixture(path.join(fixtureDirectory, MAESTRO_CONFORMANCE_RAW_FIXTURE));
  const normalized = readNormalizedFixture(
    path.join(fixtureDirectory, MAESTRO_CONFORMANCE_NORMALIZED_FIXTURE),
  );
  assertPinnedUpstream(raw.upstream);
  compareJson(normalized.upstream, raw.upstream, 'normalized fixture upstream pin');

  const regenerated = normalizeUpstreamFixture(raw, fixtureDirectory);
  compareJson(regenerated.cases, normalized.cases, 'normalized upstream cases');

  const actual = raw.cases.map((entry) => normalizeAgentCase(entry, fixtureDirectory));
  compareJson(actual, normalized.cases, 'agent-device flow model');
  return { upstream: raw.upstream, cases: actual };
}

export function regenerateConformance(
  options: {
    fixtureDirectory?: string;
  } = {},
): NormalizedFixture {
  const fixtureDirectory = options.fixtureDirectory ?? MAESTRO_CONFORMANCE_FIXTURE_DIRECTORY;
  const raw = readRawFixture(path.join(fixtureDirectory, MAESTRO_CONFORMANCE_RAW_FIXTURE));
  assertPinnedUpstream(raw.upstream);
  const normalized = normalizeUpstreamFixture(raw, fixtureDirectory);
  fs.writeFileSync(
    path.join(fixtureDirectory, MAESTRO_CONFORMANCE_NORMALIZED_FIXTURE),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  return normalized;
}

function readRawFixture(filePath: string): RawFixture {
  const value = readJson(filePath);
  const record = requiredRecord(value, filePath);
  if (record.schemaVersion !== 1) throw new Error(`${filePath} has an unsupported schemaVersion.`);
  const cases = requiredArray(record.cases, `${filePath}.cases`).map((entry, index) =>
    readRawCase(entry, `${filePath}.cases[${index}]`),
  );
  return {
    schemaVersion: 1,
    upstream: readUpstreamPin(record.upstream, `${filePath}.upstream`),
    cases,
  };
}

function readNormalizedFixture(filePath: string): NormalizedFixture {
  const value = readJson(filePath);
  const record = requiredRecord(value, filePath);
  if (record.schemaVersion !== 1) throw new Error(`${filePath} has an unsupported schemaVersion.`);
  return {
    schemaVersion: 1,
    upstream: readUpstreamPin(record.upstream, `${filePath}.upstream`),
    cases: requiredArray(record.cases, `${filePath}.cases`).map((entry, index) => {
      const caseRecord = requiredRecord(entry, `${filePath}.cases[${index}]`);
      return {
        id: requiredString(caseRecord.id, `${filePath}.cases[${index}].id`),
        flow: requiredString(caseRecord.flow, `${filePath}.cases[${index}].flow`),
        expected: requiredArray(
          caseRecord.expected,
          `${filePath}.cases[${index}].expected`,
        ) as NormalizedCase['expected'],
      };
    }),
  };
}

function readRawCase(value: unknown, name: string): RawCase {
  const record = requiredRecord(value, name);
  return {
    id: requiredString(record.id, `${name}.id`),
    flow: requiredString(record.flow, `${name}.flow`),
    commands: requiredArray(record.commands, `${name}.commands`).map((entry, index) =>
      readRawCommand(entry, `${name}.commands[${index}]`),
    ),
  };
}

function readRawCommand(value: unknown, name: string): RawCommand {
  const record = requiredRecord(value, name);
  const command: RawCommand = {
    ...record,
    type: requiredString(record.type, `${name}.type`),
  };
  if (record.source !== undefined) command.source = readSource(record.source, `${name}.source`);
  if (record.commands !== undefined) {
    command.commands = requiredArray(record.commands, `${name}.commands`).map((entry, index) =>
      readRawCommand(entry, `${name}.commands[${index}]`),
    );
  }
  return command;
}

function readUpstreamPin(value: unknown, name: string): UpstreamPin {
  const record = requiredRecord(value, name);
  const artifacts = requiredArray(record.artifacts, `${name}.artifacts`).map((entry, index) => {
    const artifact = requiredRecord(entry, `${name}.artifacts[${index}]`);
    return {
      path: requiredString(artifact.path, `${name}.artifacts[${index}].path`),
      role: requiredString(artifact.role, `${name}.artifacts[${index}].role`),
      sha256: requiredString(artifact.sha256, `${name}.artifacts[${index}].sha256`),
    } satisfies UpstreamArtifact;
  });
  return {
    project: requiredString(record.project, `${name}.project`),
    version: requiredString(record.version, `${name}.version`),
    tag: requiredString(record.tag, `${name}.tag`),
    commit: requiredString(record.commit, `${name}.commit`),
    sourceUrl: requiredString(record.sourceUrl, `${name}.sourceUrl`),
    artifacts,
  };
}

function readSource(value: unknown, name: string): UpstreamSource {
  const record = requiredRecord(value, name);
  const line = record.line;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw new Error(`${name}.line must be a positive integer.`);
  }
  return {
    path: requiredString(record.path, `${name}.path`),
    line,
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  return readRequiredRecord(value, name);
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a string.`);
  return value;
}

function assertPinnedUpstream(upstream: UpstreamPin): void {
  for (const key of ['project', 'version', 'tag', 'commit'] as const) {
    if (upstream[key] !== PINNED_UPSTREAM[key]) {
      throw new Error(
        `Upstream fixture must pin ${key}=${PINNED_UPSTREAM[key]}; found ${upstream[key]}.`,
      );
    }
  }
}

function compareJson(actual: unknown, expected: unknown, name: string): void {
  const actualJson = JSON.stringify(actual, null, 2);
  const expectedJson = JSON.stringify(expected, null, 2);
  if (actualJson === expectedJson) return;
  throw new Error(
    `${name} mismatch. Run node --experimental-strip-types scripts/maestro-conformance.ts --regenerate only after reviewing the upstream capture.\nExpected:\n${expectedJson}\nActual:\n${actualJson}`,
  );
}

function parseMode(args: readonly string[]): 'check' | 'regenerate' | 'help' {
  let mode: 'check' | 'regenerate' | 'help' = 'check';
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      mode = 'help';
      continue;
    }
    if (arg === '--check' || arg === '--regenerate') {
      const next = arg === '--check' ? 'check' : 'regenerate';
      if (mode !== 'check' && mode !== next) throw new Error('Choose only one conformance mode.');
      mode = next;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return mode;
}

function printHelp(): void {
  console.log(
    'Usage: node --experimental-strip-types scripts/maestro-conformance.ts [--check|--regenerate]',
  );
  console.log('');
  console.log(
    '  --check       Compare the parser against checked-in normalized fixtures (default).',
  );
  console.log('  --regenerate  Rebuild the normalized fixture from the pinned upstream capture.');
}

function main(args: readonly string[]): void {
  try {
    const mode = parseMode(args);
    if (mode === 'help') {
      printHelp();
      return;
    }
    if (mode === 'regenerate') {
      regenerateConformance();
      console.log(`Regenerated ${MAESTRO_CONFORMANCE_NORMALIZED_FIXTURE}.`);
      return;
    }
    const result = checkConformance();
    console.log(
      `Maestro ${result.upstream.version} conformance: ${result.cases.length} cases passed.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
