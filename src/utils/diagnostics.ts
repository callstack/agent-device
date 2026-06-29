import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactDiagnosticData } from '../kernel/redaction.ts';

type DiagnosticLevel = 'info' | 'warn' | 'error' | 'debug';

type DiagnosticEvent = {
  ts: string;
  level: DiagnosticLevel;
  phase: string;
  session?: string;
  requestId?: string;
  command?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
};

type DiagnosticsScopeOptions = {
  session?: string;
  requestId?: string;
  command?: string;
  debug?: boolean;
  logPath?: string;
  traceLogPath?: string;
};

type DiagnosticsScope = DiagnosticsScopeOptions & {
  diagnosticId: string;
  events: DiagnosticEvent[];
  liveWrittenEventCount: number;
  // Running per-phase emit tally. Unlike `events`, this is NOT cleared by
  // `flushDiagnosticsToSessionFile`, so consumers (e.g. the agent-cost graft)
  // can count phase occurrences for the whole request even in debug mode where
  // events are streamed out and reset mid-flight.
  phaseCounts: Map<string, number>;
};

const diagnosticsStorage = new AsyncLocalStorage<DiagnosticsScope>();

export function createRequestId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function createDiagnosticId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function withDiagnosticsScope<T>(
  options: DiagnosticsScopeOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const scope: DiagnosticsScope = {
    ...options,
    diagnosticId: createDiagnosticId(),
    events: [],
    liveWrittenEventCount: 0,
    phaseCounts: new Map(),
  };
  return await diagnosticsStorage.run(scope, fn);
}

export function updateDiagnosticsScope(options: DiagnosticsScopeOptions): void {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return;
  Object.assign(scope, options);
}

export function getDiagnosticsMeta(): {
  diagnosticId?: string;
  requestId?: string;
  session?: string;
  command?: string;
  debug?: boolean;
} {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return {};
  return {
    diagnosticId: scope.diagnosticId,
    requestId: scope.requestId,
    session: scope.session,
    command: scope.command,
    debug: scope.debug,
  };
}

/**
 * Sum the number of diagnostic events emitted in the current scope whose phase
 * is one of `phases`. Backed by the flush-surviving `phaseCounts` tally, so it
 * stays accurate for the whole request even under `--debug` (where `events` is
 * streamed out and reset). Returns 0 when called outside a diagnostics scope.
 */
export function countDiagnosticEventsByPhase(phases: readonly string[]): number {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return 0;
  let total = 0;
  for (const phase of phases) {
    total += scope.phaseCounts.get(phase) ?? 0;
  }
  return total;
}

export function emitDiagnostic(event: {
  level?: DiagnosticLevel;
  phase: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}): void {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return;
  const payload: DiagnosticEvent = {
    ts: new Date().toISOString(),
    level: event.level ?? 'info',
    phase: event.phase,
    session: scope.session,
    requestId: scope.requestId,
    command: scope.command,
    durationMs: event.durationMs,
    data: event.data ? redactDiagnosticData(event.data) : undefined,
  };
  scope.events.push(payload);
  scope.phaseCounts.set(event.phase, (scope.phaseCounts.get(event.phase) ?? 0) + 1);
  if (!scope.debug) return;
  const fileLine = `${JSON.stringify(payload)}\n`;
  try {
    if (scope.logPath) {
      appendDiagnosticLine(scope.logPath, fileLine);
      scope.liveWrittenEventCount = scope.events.length;
    }
    if (scope.traceLogPath) {
      appendDiagnosticLine(scope.traceLogPath, fileLine);
    }
    if (!scope.logPath && !scope.traceLogPath) {
      process.stderr.write(`[agent-device][diag] ${fileLine}`);
    }
  } catch {
    // Best-effort diagnostics should not break request flow.
  }
}

export async function withDiagnosticTimer<T>(
  phase: string,
  fn: () => Promise<T> | T,
  data?: Record<string, unknown>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    emitDiagnostic({
      level: 'info',
      phase,
      durationMs: Date.now() - start,
      data,
    });
    return result;
  } catch (error) {
    emitDiagnostic({
      level: 'error',
      phase,
      durationMs: Date.now() - start,
      data: {
        ...(data ?? {}),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export function flushDiagnosticsToSessionFile(options: { force?: boolean } = {}): string | null {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return null;
  if (!options.force && !scope.debug) return null;
  if (scope.events.length === 0) return null;

  try {
    if (scope.logPath) {
      const pendingEvents = scope.events.slice(scope.liveWrittenEventCount);
      if (pendingEvents.length > 0) {
        const lines = pendingEvents.map((entry) => JSON.stringify(redactDiagnosticData(entry)));
        appendDiagnosticLine(scope.logPath, `${lines.join('\n')}\n`);
      }
      const logPath = scope.logPath;
      scope.events = [];
      scope.liveWrittenEventCount = 0;
      return logPath;
    }

    const sessionDir = sanitizePathPart(scope.session ?? 'default');
    const dayDir = new Date().toISOString().slice(0, 10);
    const baseDir = path.join(os.homedir(), '.agent-device', 'logs', sessionDir, dayDir);
    fs.mkdirSync(baseDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(baseDir, `${timestamp}-${scope.diagnosticId}.ndjson`);
    const lines = scope.events.map((entry) => JSON.stringify(redactDiagnosticData(entry)));
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
    scope.events = [];
    return filePath;
  } catch {
    return null;
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function appendDiagnosticLine(logPath: string, line: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, line, 'utf8');
}
