import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { emitDiagnostic, getDiagnosticsMeta, updateDiagnosticsScope } from './diagnostics.ts';

export type ExecSettlementReason =
  | 'success'
  | 'exit_failure'
  | 'timeout'
  | 'abort'
  | 'spawn_error'
  | 'stdin_error';

type ExecLifecycleEvent =
  | 'spawn_start'
  | 'spawn'
  | 'deadline'
  | 'abort'
  | 'error'
  | 'exit'
  | 'close'
  | 'settled';
type ExecLifecycleData = {
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: ExecSettlementReason;
};

export function createExecTraceContext(
  cmd: string,
  args: readonly string[],
  timeoutMs: number | undefined,
  envTraceEnabled: boolean,
): { emit(event: ExecLifecycleEvent, data?: ExecLifecycleData): void } {
  const meta = getDiagnosticsMeta();
  if (!meta.debug && !envTraceEnabled) return { emit: () => {} };
  if (envTraceEnabled && !meta.flushOnSuccess) updateDiagnosticsScope({ flushOnSuccess: true });
  const started = performance.now();
  const execId = randomUUID();
  let pid: number | undefined;
  const command = path.basename(cmd);
  const simctlArgs = args[1] === '--set' ? args.slice(3) : args.slice(1);
  const operation =
    command === 'xcrun' &&
    args[0] === 'simctl' &&
    simctlArgs.length === 3 &&
    simctlArgs.join(' ') === 'list devices -j'
      ? 'simctl_list_devices'
      : undefined;
  const emit = (event: ExecLifecycleEvent, data: ExecLifecycleData = {}): void => {
    pid = data.pid ?? pid;
    emitDiagnostic({
      level: 'debug',
      phase: 'exec_command',
      durationMs: performance.now() - started,
      data: { execId, command, operation, event, pid, timeoutMs, ...data },
    });
  };
  emit('spawn_start');
  return { emit };
}
