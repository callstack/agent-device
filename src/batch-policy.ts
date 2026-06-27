import { PUBLIC_COMMANDS } from './command-catalog.ts';
import { deriveStructuredBatchCommandNames } from './core/command-descriptor/derive.ts';
import { commandDescriptors } from './core/command-descriptor/registry.ts';
import { AppError } from './utils/errors.ts';

/**
 * The exact set of command names exposed through `batch`, as a narrow union.
 *
 * This type is kept HAND-AUTHORED on purpose (ADR-0008, Phase 1 step 4): the
 * runtime allowlist below is now derived from the command-descriptor registry,
 * but the registry types each `name` as `string`, so deriving the value yields
 * `string[]`. Re-deriving the type from that value would WIDEN this union to
 * `string` and silently widen its downstream consumers — most notably
 * `BatchCommandName` (re-exported from `command-surface.ts`) and the
 * `satisfies readonly DaemonCommandName[]` guard in `commands/batch/projection.ts`.
 * Keeping the union spelled out preserves those compile-time contracts. The
 * derived runtime value is proven to match this union, member-for-member, by
 * `core/command-descriptor/__tests__/parity.test.ts`.
 */
export type StructuredBatchCommandName =
  | (typeof PUBLIC_COMMANDS)['devices']
  | (typeof PUBLIC_COMMANDS)['boot']
  | (typeof PUBLIC_COMMANDS)['shutdown']
  | (typeof PUBLIC_COMMANDS)['apps']
  | (typeof PUBLIC_COMMANDS)['open']
  | (typeof PUBLIC_COMMANDS)['close']
  | (typeof PUBLIC_COMMANDS)['install']
  | (typeof PUBLIC_COMMANDS)['reinstall']
  | (typeof PUBLIC_COMMANDS)['installFromSource']
  | (typeof PUBLIC_COMMANDS)['push']
  | (typeof PUBLIC_COMMANDS)['triggerAppEvent']
  | (typeof PUBLIC_COMMANDS)['snapshot']
  | (typeof PUBLIC_COMMANDS)['screenshot']
  | (typeof PUBLIC_COMMANDS)['diff']
  | (typeof PUBLIC_COMMANDS)['wait']
  | (typeof PUBLIC_COMMANDS)['alert']
  | (typeof PUBLIC_COMMANDS)['settings']
  | (typeof PUBLIC_COMMANDS)['click']
  | (typeof PUBLIC_COMMANDS)['press']
  | (typeof PUBLIC_COMMANDS)['longPress']
  | (typeof PUBLIC_COMMANDS)['swipe']
  | (typeof PUBLIC_COMMANDS)['focus']
  | (typeof PUBLIC_COMMANDS)['type']
  | (typeof PUBLIC_COMMANDS)['fill']
  | (typeof PUBLIC_COMMANDS)['scroll']
  | (typeof PUBLIC_COMMANDS)['get']
  | (typeof PUBLIC_COMMANDS)['gesture']
  | (typeof PUBLIC_COMMANDS)['is']
  | (typeof PUBLIC_COMMANDS)['find']
  | (typeof PUBLIC_COMMANDS)['perf']
  | (typeof PUBLIC_COMMANDS)['logs']
  | (typeof PUBLIC_COMMANDS)['network']
  | (typeof PUBLIC_COMMANDS)['record']
  | (typeof PUBLIC_COMMANDS)['trace']
  | (typeof PUBLIC_COMMANDS)['test']
  | (typeof PUBLIC_COMMANDS)['appState']
  | (typeof PUBLIC_COMMANDS)['back']
  | (typeof PUBLIC_COMMANDS)['home']
  | (typeof PUBLIC_COMMANDS)['rotate']
  | (typeof PUBLIC_COMMANDS)['appSwitcher']
  | (typeof PUBLIC_COMMANDS)['keyboard']
  | (typeof PUBLIC_COMMANDS)['clipboard']
  | (typeof PUBLIC_COMMANDS)['reactNative'];

/**
 * The structured-batch allowlist, BUILT from the command-descriptor registry
 * (the `batchable` flag) rather than hand-maintained. The derived value is a
 * `string[]`; the cast re-applies the narrow {@link StructuredBatchCommandName}
 * union, whose membership equality with this value is asserted by the parity test.
 */
export const STRUCTURED_BATCH_COMMAND_NAMES: readonly StructuredBatchCommandName[] =
  deriveStructuredBatchCommandNames(commandDescriptors) as readonly StructuredBatchCommandName[];

export const BATCH_BLOCKED_COMMANDS: ReadonlySet<string> = new Set(['batch', 'replay']);

export const BATCH_DAEMON_STEP_KEYS = ['command', 'positionals', 'flags', 'runtime'] as const;

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
