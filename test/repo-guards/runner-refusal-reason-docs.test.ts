import assert from 'node:assert/strict';
import { test } from 'vitest';
import { memberPath } from '../../scripts/layering/layering-ast.ts';
import { collectReasonTables } from '../../scripts/reasons/collect.ts';
import {
  exportedConstObject,
  parseTs,
  readRepoFile,
  unwrapAssertion,
} from './runner-source-assertions.ts';

/**
 * `error.details.reason` is a published vocabulary: a client that branches on it treats an
 * undocumented member as an unknown value. Every exported typed published-reason table must have
 * each reason documented at the surfaces that enumerate it, in the same change that adds it.
 * Reason tables are read by the collector the reasons page uses; the runner code rows, which are not a
 * reason table, and the claim-conflict union are read as typed syntax (oxc), so an unreadable member
 * fails here instead of being dropped.
 */

type Surface = Readonly<{ name: string; relativePath: string }>;
type Kind = 'table' | 'runnerCodes' | 'union';
const commandsDoc: Surface = { name: 'commands.md', relativePath: 'website/docs/docs/commands.md' };
const cliHelpWorkflows: Surface = {
  name: 'cli-help-workflows.ts',
  relativePath: 'src/commands/schema/cli-help-workflows.ts',
};

const reasonTable = (
  name: string,
  relativePath: string,
  kind: Kind,
  surfaces: readonly Surface[] = [commandsDoc],
) => ({ name, relativePath, kind, surfaces });

const REASON_TABLES = [
  reasonTable('RUNNER_ERROR_CODES', 'packages/apple-runner/src/runner-contract.ts', 'runnerCodes'),
  reasonTable('PRE_DISPATCH_REFUSAL_REASONS', 'packages/kernel/src/errors.ts', 'table'),
  reasonTable('SCROLL_REASONS', 'packages/contracts/src/scroll-reasons.ts', 'table'),
  reasonTable(
    'ANDROID_SCREEN_RECORDING_REASONS',
    'packages/contracts/src/screen-recording-runtime-host.ts',
    'table',
  ),
  reasonTable('WAIT_REASONS', 'packages/contracts/src/wait.ts', 'table', [
    commandsDoc,
    cliHelpWorkflows,
  ]),
  reasonTable('DeviceClaimConflictReason', 'packages/contracts/src/device-inventory.ts', 'union'),
];

test('every reason of every exported published-reason table is documented at its surfaces', () => {
  for (const table of REASON_TABLES) {
    const reasons = readReasons(
      readRepoFile(table.relativePath),
      table.relativePath,
      table.name,
      table.kind,
    );
    assert.ok(reasons.length > 0, `${table.name} must declare at least one reason`);
    for (const surface of table.surfaces) {
      const docs = readRepoFile(surface.relativePath);
      for (const reason of reasons) {
        assert.ok(
          documentsReason(docs, reason),
          `${surface.name} must document the ${reason} reason: ${table.name} in ${table.relativePath} publishes it as details.reason.`,
        );
      }
    }
  }
});

test('a documented reason does not stand in for a longer undocumented one', () => {
  assert.ok(documentsReason('reports `back_swipe_no_change` here', 'back_swipe_no_change'));
  assert.ok(documentsReason('reason: DEVICE_CLAIM_LIVE_OWNER.', 'DEVICE_CLAIM_LIVE_OWNER'));
  assert.ok(!documentsReason('reports `back_swipe_no_change_extra`', 'back_swipe_no_change'));
  assert.ok(!documentsReason('reports `pre_back_swipe_no_change`', 'back_swipe_no_change'));
  assert.ok(!documentsReason('reports back-swipe_no_change-x', 'swipe_no_change'));
  assert.ok(!documentsReason('reports `DEVICE_CLAIM_LIVE_OWNER_EXTRA`', 'DEVICE_CLAIM_LIVE_OWNER'));
});

test('the extractors read every member and reject unsupported ones instead of dropping them', () => {
  const read = (source: string, name: string, kind: Kind) =>
    readReasons(source, 'packages/a/src/table.ts', name, kind);
  const expectRead = (source: string, name: string, kind: Kind, expected: string[]) =>
    assert.deepEqual(read(source, name, kind), expected);
  const expectReject = (source: string, name: string, kind: Kind, pattern: RegExp) =>
    assert.throws(() => read(source, name, kind), pattern);
  const codes = (reason: string) =>
    `export const R = {
    // Busy.
    busy: { reason: 'runner_busy' } } as const satisfies ReasonTable<'r'>;
    export const RUNNER_ERROR_CODES = { RUNNER_BUSY: { dispatched: 'no', reason: ${reason} }, RUNNER_WEDGED: { dispatched: 'no' } } as const satisfies Record<string, RunnerErrorCodeRow>;`;

  expectRead(codes('R.busy.reason'), 'RUNNER_ERROR_CODES', 'runnerCodes', ['runner_busy']);
  expectReject(
    codes('R.gone.reason'),
    'RUNNER_ERROR_CODES',
    'runnerCodes',
    /RUNNER_ERROR_CODES row RUNNER_BUSY must write its reason as a literal or read it from a reason table row/,
  );
  expectRead(codes("'runner_busy'"), 'RUNNER_ERROR_CODES', 'runnerCodes', ['runner_busy']);
  expectRead(
    `export const WAIT_REASONS = {
      // Stalled.
      captureStalled: { reason: 'wait_capture_stalled' },
    } as const satisfies ReasonTable<'wait'>;`,
    'WAIT_REASONS',
    'table',
    ['wait_capture_stalled'],
  );
  expectRead(
    `export type DeviceClaimConflictReason = 'DEVICE_CLAIM_LIVE_OWNER' | 'DEVICE_CLAIM_OWNER_UNCERTAIN';`,
    'DeviceClaimConflictReason',
    'union',
    ['DEVICE_CLAIM_LIVE_OWNER', 'DEVICE_CLAIM_OWNER_UNCERTAIN'],
  );
  expectReject(
    `export type DeviceClaimConflictReason = string;`,
    'DeviceClaimConflictReason',
    'union',
    /unsupported member in DeviceClaimConflictReason/,
  );
});

/** Whether `docs` names `reason` as a whole token, so a longer reason that extends it does not count. */
function documentsReason(docs: string, reason: string): boolean {
  assert.match(reason, /^[A-Za-z0-9_-]+$/, 'a reason is a token, so it needs no escaping');
  return new RegExp(`(?<![A-Za-z0-9_-])${reason}(?![A-Za-z0-9_-])`).test(docs);
}

/** Reads a published-reason table's members, failing on anything unreadable. */
function readReasons(source: string, filename: string, name: string, kind: Kind): string[] {
  if (kind === 'union') return readUnionReasons(parseTs(filename, source), filename, name);
  const tables = collectReasonTables(new Map([[filename, source]]));
  if (kind === 'table') {
    const table = tables.find((candidate) => candidate.name === name);
    assert.ok(table, `${filename} must declare the ${name} reason table`);
    return table.rows.map(({ reason }) => reason);
  }
  return readRunnerCodeReasons(parseTs(filename, source), tables, name);
}

/**
 * The reasons the rows of the runner code table publish. A row writes its reason as
 * a literal or `TABLE.member.reason`, which must name a row of a reason table in the same file.
 */
function readRunnerCodeReasons(
  parsed: ReturnType<typeof parseTs>,
  tables: ReturnType<typeof collectReasonTables>,
  name: string,
): string[] {
  return exportedConstObject(parsed, name).properties.flatMap((property: any) => {
    const row = unwrapAssertion(property.value);
    const reason = row?.properties?.find((member: any) => member.key?.name === 'reason');
    if (reason === undefined) return [];
    if (reason.value.type === 'Literal' && typeof reason.value.value === 'string') {
      return [reason.value.value];
    }
    const [table, member, field] = memberPath(reason.value) ?? [];
    const found = tables
      .find((candidate) => candidate.name === table)
      ?.rows.find((candidate) => candidate.member === member);
    assert.ok(
      field === 'reason' && found !== undefined,
      `${name} row ${property.key.name} must write its reason as a literal or read it from a reason table row as TABLE.member.reason.`,
    );
    return [found.reason];
  });
}

/** The string members of an exported `type Name = 'a' | 'b'` union. */
function readUnionReasons(
  parsed: ReturnType<typeof parseTs>,
  filename: string,
  name: string,
): string[] {
  const aliases = parsed.program.body.flatMap((statement) =>
    statement.type === 'ExportNamedDeclaration' &&
    statement.declaration?.type === 'TSTypeAliasDeclaration'
      ? [statement.declaration]
      : [],
  );
  const alias = aliases.find(
    (candidate) => candidate.id.type === 'Identifier' && candidate.id.name === name,
  );
  assert.ok(alias !== undefined, `${filename} must export the ${name} union.`);
  const annotation = alias.typeAnnotation;
  const members = annotation.type === 'TSUnionType' ? annotation.types : [annotation];
  return members.map((member) => {
    assert.ok(
      member.type === 'TSLiteralType' &&
        member.literal.type === 'Literal' &&
        typeof member.literal.value === 'string',
      `unsupported member in ${name}: ${member.type}`,
    );
    return member.literal.value;
  });
}
