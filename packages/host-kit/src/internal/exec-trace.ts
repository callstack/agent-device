import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseBooleanLiteral, type EnvMap } from '@agent-device/kernel/source-value';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  updateDiagnosticsScope,
} from './diagnostics.ts';

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
  timeoutMs: number | undefined,
  hostEnv: EnvMap | undefined,
): { emit(event: ExecLifecycleEvent, data?: ExecLifecycleData): void } {
  const envTraceEnabled = parseBooleanLiteral(hostEnv?.AGENT_DEVICE_EXEC_TRACE ?? '') === true;
  const meta = getDiagnosticsMeta();
  if (!meta.debug && !envTraceEnabled) return { emit: () => {} };
  if (envTraceEnabled && !meta.flushOnSuccess) updateDiagnosticsScope({ flushOnSuccess: true });
  const started = performance.now();
  const execId = randomUUID();
  let pid: number | undefined;
  let settlementEmitted = false;
  const command = path.basename(cmd);
  const emit = AsyncLocalStorage.bind(
    (event: ExecLifecycleEvent, data: ExecLifecycleData = {}): void => {
      pid = data.pid ?? pid;
      emitDiagnostic({
        level: 'debug',
        phase: 'exec_command',
        durationMs: performance.now() - started,
        data: { execId, command, event, pid, timeoutMs, ...data },
      });
      if (event === 'settled') settlementEmitted = true;
      if (envTraceEnabled && (event === 'settled' || (event === 'close' && settlementEmitted))) {
        flushDiagnosticsToSessionFile();
      }
    },
  );
  emit('spawn_start');
  return { emit };
}
