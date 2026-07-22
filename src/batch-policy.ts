import { deriveStructuredBatchCommandNames } from './core/command-descriptor/derive.ts';
import { commandDescriptors } from './core/command-descriptor/registry.ts';
import { AppError } from './kernel/errors.ts';

/**
 * The exact set of command names exposed through `batch`, as a narrow union.
 *
 * DERIVED from the command-descriptor registry (ADR-0008, Phase 1 step 7): the
 * registry is now `as const` (#910), so each entry keeps its literal `name` and
 * literal `batchable`. Extracting the entries whose `batchable` is `true` and
 * indexing their `name` reconstructs this union from the same single source the
 * runtime allowlist below is built from — no hand-maintained list to drift. The
 * downstream contracts (`BatchCommandName` in `commands/batch/projection.ts` and
 * its `satisfies readonly DaemonCommandName[]` guard) are still enforced by `tsc`.
 */
export type StructuredBatchCommandName = Extract<
  (typeof commandDescriptors)[number],
  { batchable: true }
>['name'];

/**
 * The structured-batch allowlist, BUILT from the command-descriptor registry
 * (the `batchable` flag) rather than hand-maintained. {@link deriveStructuredBatchCommandNames}
 * folds over the registry as `readonly CommandDescriptor[]`, so it returns
 * `string[]`; the cast re-applies the narrow {@link StructuredBatchCommandName}
 * union (which derives from the same `batchable: true` entries). The parity test
 * guards the wiring (the exported value equals the derived fold).
 */
export const STRUCTURED_BATCH_COMMAND_NAMES: readonly StructuredBatchCommandName[] =
  deriveStructuredBatchCommandNames(commandDescriptors) as readonly StructuredBatchCommandName[];

const BATCH_BLOCKED_COMMANDS: ReadonlySet<string> = new Set(['batch', 'replay']);

export const BATCH_DAEMON_STEP_KEYS = [
  'command',
  'positionals',
  'input',
  'flags',
  'runtime',
] as const;

export const INHERITED_PARENT_FLAG_KEYS = [
  'platform',
  'target',
  'device',
  'udid',
  'serial',
  'verbose',
  'out',
] as const;

const structuredBatchCommandNames = new Set<string>(STRUCTURED_BATCH_COMMAND_NAMES);

function isStructuredBatchCommandName(command: string): command is StructuredBatchCommandName {
  return structuredBatchCommandNames.has(command);
}

export function normalizeBatchCommandName(command: unknown): string {
  return typeof command === 'string' ? command.trim().toLowerCase() : '';
}

export function readStructuredBatchCommandName(
  command: unknown,
  stepNumber: number,
): StructuredBatchCommandName {
  const normalized = normalizeBatchCommandName(command);
  if (isStructuredBatchCommandName(normalized)) return normalized;
  throw new AppError(
    'INVALID_ARGS',
    `Batch step ${stepNumber} command is not available through command batch: ${String(command)}`,
  );
}

export function assertBatchRuntimeCommandAllowed(command: string, stepNumber: number): void {
  if (BATCH_BLOCKED_COMMANDS.has(command)) {
    throw new AppError('INVALID_ARGS', `Batch step ${stepNumber} cannot run ${command}.`);
  }
}
