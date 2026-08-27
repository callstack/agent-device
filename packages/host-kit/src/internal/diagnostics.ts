import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';
import type { DiagnosticsRecordRef } from '@agent-device/kernel/errors';

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
  flushOnSuccess?: boolean;
  logPath?: string;
  /**
   * Set together with `logPath` whenever that path is a session request
   * diagnostics record — the locator a remote caller fetches the same record
   * by. Both come from one `resolveSessionRequestLog` result, so the path and
   * the locator cannot name different records (#1801).
   */
  logRecord?: DiagnosticsRecordRef;
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
  sensitiveValues: Set<string>;
  ensuredDirectories: Set<string>;
  // Sorted-longest-first view of `sensitiveValues`, recomputed lazily after a
  // registration invalidates it so replacement order stays deterministic.
  sortedSensitiveValues?: string[];
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
    sensitiveValues: new Set(),
    ensuredDirectories: new Set(),
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
  flushOnSuccess?: boolean;
} {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return {};
  const { diagnosticId, requestId, session, command, debug, flushOnSuccess } = scope;
  return { diagnosticId, requestId, session, command, debug, flushOnSuccess };
}

/** Register a caller-declared literal that must not reach this request's diagnostics. */
export function registerDiagnosticSensitiveValue(value: string): void {
  if (!value) return;
  const scope = diagnosticsStorage.getStore();
  if (!scope) return;
  scope.sensitiveValues.add(value);
  scope.sortedSensitiveValues = undefined;
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
    data: event.data ? redactScopeData(scope, event.data) : undefined,
  };
  scope.events.push(payload);
  scope.phaseCounts.set(event.phase, (scope.phaseCounts.get(event.phase) ?? 0) + 1);
  if (!scope.debug && !scope.traceLogPath) return;
  const fileLine = `${JSON.stringify(payload)}\n`;
  try {
    if (scope.debug && scope.logPath) {
      appendDiagnosticLine(scope, scope.logPath, fileLine);
      scope.liveWrittenEventCount = scope.events.length;
    }
    if (scope.traceLogPath) {
      appendDiagnosticLine(scope, scope.traceLogPath, fileLine);
    }
    if (scope.debug && !scope.logPath && !scope.traceLogPath) {
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

/**
 * Where a flushed diagnostics record landed: a path on THIS host, plus the
 * locator a remote caller can fetch the same record by when the record is a
 * session request record. `ref` is absent for the homedir fallback file below,
 * which no daemon route serves.
 */
export type FlushedDiagnosticsRecord = {
  path: string;
  ref?: DiagnosticsRecordRef;
};

export function flushDiagnosticsToSessionFile(
  options: { force?: boolean } = {},
): FlushedDiagnosticsRecord | null {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return null;
  if (!options.force && !scope.debug && !scope.flushOnSuccess) return null;
  if (scope.events.length === 0) return null;
  const values = sortedScopeSensitiveValues(scope);

  try {
    if (scope.logPath) {
      const pendingEvents = scope.events.slice(scope.liveWrittenEventCount);
      if (pendingEvents.length > 0) {
        // Data payloads are fully redacted once at emit time; this flush pass
        // repeats only the caller-declared literal replacement so literals
        // registered after an emit are still scrubbed. Metadata fields are
        // generated identifiers and internal phase names, deliberately no
        // longer re-normalized here. Replacement output is not length-bounded:
        // a short literal can grow past `[REDACTED]`.
        const lines = pendingEvents.map((entry) =>
          JSON.stringify(replaceSensitiveValues(entry, values)),
        );
        appendDiagnosticLine(scope, scope.logPath, `${lines.join('\n')}\n`);
      }
      const logRecord = scope.logRecord;
      scope.events = [];
      scope.liveWrittenEventCount = 0;
      return { path: scope.logPath, ...(logRecord ? { ref: logRecord } : {}) };
    }

    const sessionDir = sanitizePathPart(scope.session ?? 'default');
    const dayDir = new Date().toISOString().slice(0, 10);
    const baseDir = path.join(os.homedir(), '.agent-device', 'logs', sessionDir, dayDir);
    fs.mkdirSync(baseDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(baseDir, `${timestamp}-${scope.diagnosticId}.ndjson`);
    // Same single-value-replacement re-pass as the logPath branch above.
    const lines = scope.events.map((entry) =>
      JSON.stringify(replaceSensitiveValues(entry, values)),
    );
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
    scope.events = [];
    return { path: filePath };
  } catch {
    return null;
  }
}

/** Longest-first so an overlapping shorter literal cannot truncate a longer one. */
function sortedScopeSensitiveValues(scope: DiagnosticsScope): readonly string[] {
  scope.sortedSensitiveValues ??= [...scope.sensitiveValues].sort(
    (left, right) => right.length - left.length,
  );
  return scope.sortedSensitiveValues;
}

function redactScopeData<T>(scope: DiagnosticsScope, input: T): T {
  const redacted = redactDiagnosticData(input);
  return replaceSensitiveValues(redacted, sortedScopeSensitiveValues(scope)) as T;
}

function replaceSensitiveValues(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === 'string') {
    return sensitiveValues.reduce(
      (output, sensitive) => output.replaceAll(sensitive, '[REDACTED]'),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceSensitiveValues(entry, sensitiveValues));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      replaceSensitiveValues(entry, sensitiveValues),
    ]),
  );
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function appendDiagnosticLine(scope: DiagnosticsScope, logPath: string, line: string): void {
  const dir = path.dirname(logPath);
  if (!scope.ensuredDirectories.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    scope.ensuredDirectories.add(dir);
  }
  fs.appendFileSync(logPath, line, 'utf8');
}
