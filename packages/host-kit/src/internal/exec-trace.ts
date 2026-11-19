import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { parseBooleanLiteral, type EnvMap } from '@agent-device/kernel/source-value';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  updateDiagnosticsScope,
} from './diagnostics.ts';
import type { ExecOptions } from './exec.ts';

/** The diagnostic phase of each host process lifecycle event. */
export const EXEC_COMMAND_PHASE = 'exec_command';

export type ExecSettlementReason =
  | 'success'
  | 'exit_failure'
  | 'timeout'
  | 'output_limit'
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
        phase: EXEC_COMMAND_PHASE,
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

export function commandSettlementReason(input: {
  didAbort: boolean;
  exceededStream: 'stdout' | 'stderr' | undefined;
  didTimeout: boolean;
  code: number | null;
  allowFailure: boolean | undefined;
}): ExecSettlementReason {
  if (input.didAbort) return 'abort';
  if (input.didTimeout) return 'timeout';
  if (input.exceededStream) return 'output_limit';
  return (input.code ?? 1) !== 0 && !input.allowFailure ? 'exit_failure' : 'success';
}

export function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const timeout = Math.floor(value as number);
  if (timeout <= 0) return undefined;
  return timeout;
}

/**
 * Best-effort process-group signalling, shared by host-kit callers. The command kill
 * ordering lives here with the settlement vocabulary, below host-process.ts, so no
 * module has to import exec.ts to signal a child. Only positive integer pids are
 * accepted: zero targets this process's group, and negative values can target unrelated
 * processes.
 */
export function signalProcessGroupBestEffort(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * A killed command settles when its direct child exits: descendants can keep inherited pipes
 * open indefinitely. Both kill/exit orderings must settle once without waiting for `close`.
 */
export function bindCommandLifecycle(
  child: ChildProcess,
  options: Pick<ExecOptions, 'detached' | 'signal' | 'kill'>,
  trace: ReturnType<typeof createExecTraceContext>,
  settle: (code: number | null) => void,
) {
  const settlement = createCommandKillSettlement({
    killProcessTree: () => killProcessTree(child, options),
    settle,
  });
  const abort = watchCommandAbort(options, () => {
    trace.emit('abort');
    settlement.requestKill();
  });
  child.once('exit', (code, signal) => {
    trace.emit('exit', { exitCode: code, signal });
    settlement.recordExit(code);
  });
  child.once('close', (code, signal) => {
    trace.emit('close', { exitCode: code, signal });
    settle(code);
  });
  return { settlement, abort };
}

type CommandKillSettlement = {
  /** Signals the command's process tree, then settles the command if its child is gone. */
  readonly requestKill: () => void;
  /** Records the child's exit, then settles the command if a kill was already requested. */
  readonly recordExit: (code: number | null) => void;
};

function createCommandKillSettlement(input: {
  readonly killProcessTree: () => void;
  readonly settle: (exitCode: number | null) => void;
}): CommandKillSettlement {
  let killRequested = false;
  let exited = false;
  let exitCode: number | null = null;
  const settleIfKilledAndGone = (): void => {
    if (killRequested && exited) input.settle(exitCode);
  };
  return {
    requestKill: () => {
      killRequested = true;
      input.killProcessTree();
      settleIfKilledAndGone();
    },
    recordExit: (code) => {
      exited = true;
      exitCode = code ?? 1;
      settleIfKilledAndGone();
    },
  };
}

function watchCommandAbort(
  options: Pick<ExecOptions, 'detached' | 'signal'>,
  onKill: () => void,
): { readonly didAbort: boolean; dispose: () => void } {
  let didAbort = false;
  const onAbort = () => {
    didAbort = true;
    onKill();
  };
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }
  return {
    get didAbort() {
      return didAbort;
    },
    dispose: () => {
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

// Surviving descendants keep a detached process group reserved after its direct child exits.
export function killProcessTree(
  child: ChildProcess,
  options: Pick<ExecOptions, 'detached' | 'kill'>,
): void {
  if (!options.kill) {
    signalProcessTree(child, options.detached, 'SIGKILL');
    return;
  }
  // Escalation bounds graceful cleanup; the unref timer cannot keep a worker alive.
  signalProcessTree(child, options.detached, options.kill.signal);
  const escalation = setTimeout(
    () => signalProcessTree(child, options.detached, 'SIGKILL'),
    options.kill.graceMs,
  );
  escalation.unref();
  child.once('exit', () => clearTimeout(escalation));
}

function signalProcessTree(
  child: ChildProcess,
  detached: boolean | undefined,
  signal: NodeJS.Signals,
): void {
  if (detached && child.pid && process.platform !== 'win32') {
    signalProcessGroupBestEffort(child.pid, signal);
    return;
  }
  // A reaped, non-detached child can have its pid reassigned to an unrelated process.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
}

/**
 * A kill that cannot reach an inherited-pipe holder must at least stop this process
 * from holding the other end of those pipes open after it has settled.
 */
export function destroyCommandStreams(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
