import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';
import type { JsonValue } from '@agent-device/contracts/client';
import type { DiagnosticsRecordRef } from '@agent-device/kernel/errors';

/**
 * Says {@link value} on this process's stderr, and costs nothing when the stream will not take it.
 *
 * This is the sink for a report whose own route is the thing that failed — a refused state path, a log handle
 * that broke mid-write, a pipe nobody reads. Such a line cannot go where its subject could not go, so stderr
 * is the route, and the write is contained: a report is never worth the flow that was making it. Whether the
 * stream took the line changes no caller's answer, so it is not reported.
 */
export function writeHostStderrBestEffort(value: string): void {
  try {
    process.stderr.write(value);
  } catch {
    // A closed pipe makes the whole thing cost nothing.
  }
}

/** The severity an event is recorded with. */
export type DiagnosticLevel = 'info' | 'warn' | 'error' | 'debug';

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

/**
 * A log line handed to the owner that appends it, plus the seam that lets go of whatever it holds.
 *
 * The sink owns the write and everything a write needs to be safe at that path: the handle the bytes
 * travel through, and where a line goes when that route is refused or breaks. `write` never raises — a
 * diagnostic that cannot land is a lost line, never a failed request — and answers whether the sink is
 * still usable. One that reports otherwise has already routed the line somewhere safe, and the next line
 * asks for a fresh judgment instead of pushing bytes at a dead route forever.
 */
export type DiagnosticLineSink = Readonly<{
  write: (line: string) => boolean;
  close: () => void;
}>;

/**
 * Asks where lines for `logPath` are to go, and writes them THERE rather than at the name.
 *
 * A scope that names a log path does not always own the right to append at that name, and the ground
 * can change while the scope runs. `appendDiagnosticLine` therefore asks on the FIRST line and keeps
 * the sink that answer produced, so an idle scope writes nothing — it never opens a path merely to
 * decide whether it may log — and every line, including the final forced flush, travels through the
 * handle the answer checked. A sink that fails is closed and dropped, and the next line re-asks, so a
 * route that stopped being usable costs one line and does not reopen a refused name by itself.
 */
type DiagnosticLineSinkFactory = (logPath: string) => DiagnosticLineSink;

type DiagnosticsScopeOptions = {
  session?: string;
  requestId?: string;
  command?: string;
  debug?: boolean;
  flushOnSuccess?: boolean;
  logPath?: string;
  /**
   * Set with `logPath` when appending at that path must be judged rather than assumed — the
   * daemon's log is a state record, and a sink over it is only owed to a line while the state
   * rule accepts it. Lines go through the sink this produces, never through `fs.appendFileSync`.
   */
  logSinkFactory?: DiagnosticLineSinkFactory;
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
  flushedLogPath?: string;
  /** The sink the last answer produced for `logPath`, kept until the next failure re-asks. */
  logSink?: DiagnosticLineSink;
  /**
   * Whether this scope is ASKING for its sink right now. Set only while the factory runs, and cleared
   * however that ask ends: a scope left permanently in it would route every later line to stderr.
   */
  establishingLogSink?: boolean;
  /**
   * Whether a warning about a line this scope could not write is being made right now. Set only for that
   * act, and cleared however it ends: a scope left permanently in it would keep its log unused.
   */
  reportingUndeliverableLine?: boolean;
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

/** Prefixes each diagnostic event that a `--debug` client without a log file writes to stderr. */
export const DIAGNOSTIC_STDERR_PREFIX = '[agent-device][diag] ';

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
  try {
    return await diagnosticsStorage.run(scope, fn);
  } finally {
    // The sink is owed to this scope and no longer: its descriptor must not outlive the body that
    // earned it. Anything the body's own final flush wrote has already gone through it.
    closeDiagnosticLineSink(scope);
  }
}

export function updateDiagnosticsScope(options: DiagnosticsScopeOptions): void {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return;
  if ('logPath' in options && options.logPath !== scope.logPath) {
    // A scope that moves to another log lets go of the handle it held for the old one, AND of the judge that
    // produced it: a sink is asked for one path and answers for no other, and the next path is a different
    // owner's ground. A caller that moves the log without a new factory gets the plain append it had before
    // any sink existed — which is what a session request record does here.
    closeDiagnosticLineSink(scope);
    scope.logSink = undefined;
    if (!('logSinkFactory' in options)) scope.logSinkFactory = undefined;
  }
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

/** A warning about one on-disk resource, handed to a caller that records it once its log exists. */
export type ResourceDiagnostic = Readonly<{
  phase: string;
  resourcePath: string;
  data: Readonly<Record<string, unknown>>;
}>;

export type DiagnosticEventInput = {
  level?: DiagnosticLevel;
  phase: string;
  durationMs?: number;
  data?: Record<string, unknown>;
};

/**
 * Encodes diagnostic data for JSON-only ports, preserving bigints as decimal strings.
 * Performs no redaction; the receiving diagnostics port owns redaction.
 * Throws when serialization fails or the input does not encode as a JSON value.
 */
export function toDiagnosticJson(value: unknown): JsonValue {
  return JSON.parse(stringifyDiagnosticValue(value));
}

function stringifyDiagnosticValue(value: unknown, sensitiveValues: readonly string[] = []): string {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === 'bigint' || typeof entry === 'string'
      ? replaceSensitiveValues(entry, sensitiveValues)
      : entry,
  );
}

function stringifyDiagnosticEvent(
  event: DiagnosticEvent,
  sensitiveValues: readonly string[] = [],
): string {
  try {
    return stringifyDiagnosticValue(event, sensitiveValues);
  } catch {
    const { data: _data, ...metadata } = event;
    return stringifyDiagnosticValue(
      { ...metadata, data: { reason: 'diagnostic-data-unserializable' } },
      sensitiveValues,
    );
  }
}

export function emitDiagnostic(event: DiagnosticEventInput): void {
  const scope = diagnosticsStorage.getStore();
  if (!scope) return;
  try {
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
    const fileLine = `${stringifyDiagnosticEvent(payload, sortedScopeSensitiveValues(scope))}\n`;
    if (scope.debug && scope.logPath) {
      // Only count a line as already written when it is on the file. A line the route could not deliver
      // stays owed, so the final flush asks for it again rather than reporting a record that lacks it.
      if (appendDiagnosticLine(scope, scope.logPath, fileLine)) {
        scope.liveWrittenEventCount = scope.events.length;
      }
    }
    if (scope.traceLogPath) {
      appendDiagnosticLine(scope, scope.traceLogPath, fileLine);
    }
    if (scope.debug && !scope.logPath && !scope.traceLogPath) {
      process.stderr.write(`${DIAGNOSTIC_STDERR_PREFIX}${fileLine}`);
    }
  } catch {
    // Best-effort diagnostics should not break request flow.
  }
}

export async function withDiagnosticTimer<T>(
  phase: string,
  fn: () => Promise<T> | T,
  data?: Record<string, unknown> | (() => Record<string, unknown>),
  startEvent?: string,
): Promise<T> {
  const now = startEvent ? () => performance.now() : () => Date.now();
  const start = now();
  const eventData = () => (typeof data === 'function' ? data() : data);
  if (startEvent) emitDiagnostic({ phase, data: { ...eventData(), event: startEvent } });
  try {
    const result = await fn();
    emitDiagnostic({
      level: 'info',
      phase,
      durationMs: now() - start,
      data: startEvent ? { ...eventData(), event: 'settled' } : eventData(),
    });
    return result;
  } catch (error) {
    emitDiagnostic({
      level: 'error',
      phase,
      durationMs: now() - start,
      data: {
        ...eventData(),
        ...(startEvent
          ? { event: 'settled' }
          : { error: error instanceof Error ? error.message : String(error) }),
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
    const logPath = scope.logPath ?? scope.flushedLogPath;
    if (logPath) {
      const pendingEvents = scope.events.slice(scope.liveWrittenEventCount);
      if (pendingEvents.length > 0) {
        // Data payloads are fully redacted once at emit time; this flush pass
        // repeats only the caller-declared literal replacement so literals
        // registered after an emit are still scrubbed. Metadata fields are
        // generated identifiers and internal phase names, deliberately no
        // longer re-normalized here. Replacement output is not length-bounded:
        // a short literal can grow past `[REDACTED]`.
        const lines = pendingEvents.map((entry) => stringifyDiagnosticEvent(entry, values));
        if (!appendDiagnosticLine(scope, logPath, `${lines.join('\n')}\n`)) {
          // The line did not land, so there is no record to hand out. The events stay owed: a caller
          // is told no record exists rather than pointed at a file that holds none of them.
          return null;
        }
      }
      const logRecord = scope.logRecord;
      scope.events = [];
      scope.liveWrittenEventCount = 0;
      return { path: logPath, ...(logRecord ? { ref: logRecord } : {}) };
    }

    const sessionDir = sanitizePathPart(scope.session ?? 'default');
    const dayDir = new Date().toISOString().slice(0, 10);
    const baseDir = path.join(os.homedir(), '.agent-device', 'logs', sessionDir, dayDir);
    fs.mkdirSync(baseDir, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const filePath = path.join(baseDir, `${timestamp}-${scope.diagnosticId}.ndjson`);
    // Same single-value-replacement re-pass as the logPath branch above.
    const lines = scope.events.map((entry) => stringifyDiagnosticEvent(entry, values));
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
    scope.flushedLogPath = filePath;
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

function redactScopeData(
  scope: DiagnosticsScope,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const values = sortedScopeSensitiveValues(scope);
  try {
    return replaceSensitiveValues(redactDiagnosticData(input), values) as Record<string, unknown>;
  } catch {
    return replaceSensitiveValues({ reason: 'diagnostic-data-unserializable' }, values) as Record<
      string,
      unknown
    >;
  }
}

function replaceSensitiveValues(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === 'bigint') value = value.toString();
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
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Sends one line to the route that log path has, and answers whether it LANDED there.
 *
 * The answer is what makes a record's promise honest: `flushDiagnosticsToSessionFile` reports the path it
 * wrote, and a caller told about a file can open it expecting this scope's events. Every route that gives up
 * — a plain append that breaks, a sink its owner refuses, a line diverted to stderr while its own path is
 * being judged or reported on — answers `false`, so the flush says no record exists instead of naming a file
 * that holds none of them.
 */
function appendDiagnosticLine(scope: DiagnosticsScope, logPath: string, line: string): boolean {
  // A warning ABOUT a failed write is itself a line, and the route it would take is the one that just failed.
  // Sending it there would ask the same I/O that is failing, once per warning, until the stack gives out, so
  // while one is being reported every line leaves by stderr and nothing touches the path.
  if (scope.reportingUndeliverableLine) {
    writeHostStderrBestEffort(line);
    return false;
  }
  // A judged sink is owed only to the path its owner named, and only while that is still the path in
  // play: a scope that moved on to another log asks that one with a sink of its own.
  const factory = logPath === scope.logPath ? scope.logSinkFactory : undefined;
  if (!factory) {
    try {
      ensureDirectoryForLog(scope, logPath);
      fs.appendFileSync(logPath, line, 'utf8');
      return true;
    } catch (error) {
      reportUndeliverableDiagnosticLine(scope, error);
      writeHostStderrBestEffort(line);
      return false;
    }
  }
  // Asked at the FIRST line, never before one exists: a scope that logs nothing creates nothing,
  // changes no mode, and holds no descriptor. Every line after that answer, the forced final flush
  // included, goes through the handle the answer checked and never through the name again.
  //
  // While the ask is in flight, ITS OWN path has no sink yet — including for a line the setup emits
  // about that path. Such a line goes to stderr: writing it at the name would reach ground whose
  // judgment is what is being made, and asking the factory again would open the path once per warning.
  if (scope.establishingLogSink) {
    writeHostStderrBestEffort(line);
    return false;
  }
  const sink = scope.logSink ?? establishDiagnosticLineSink(scope, factory, logPath);
  if (!sink) {
    writeHostStderrBestEffort(line);
    return false;
  }
  try {
    if (sink.write(line)) return true;
    closeDiagnosticLineSink(scope);
  } catch (error) {
    // A sink's `write` is not owed the caller's flow: the route is dropped so the next line is judged
    // again, and this one is said where a broken handle cannot swallow it.
    closeDiagnosticLineSink(scope);
    reportUndeliverableDiagnosticLine(scope, error);
    writeHostStderrBestEffort(line);
  }
  return false;
}

/**
 * Asks the sink's owner for the handle one path's lines travel through, or `undefined` when it refuses.
 *
 * `scope.establishingLogSink` is set for the whole ask and the answer is stored only after it. Two
 * things follow, and both are needed:
 *
 * - A warning the SETUP itself emits — the state rule reporting a mode it could not narrow on the
 *   log's own descriptor is one — is kept OUT of the sink being built, because `appendDiagnosticLine`
 *   sees the flag and routes that line to stderr. Sink setup therefore never writes into, or re-asks
 *   for, the handle whose authority is still being decided.
 * - No half-made sink can be used: while the ask runs the scope holds no sink, so nothing can push
 *   bytes through a handle whose owner has not finished deciding that the path may be written at all.
 */
function establishDiagnosticLineSink(
  scope: DiagnosticsScope,
  factory: DiagnosticLineSinkFactory,
  logPath: string,
): DiagnosticLineSink | undefined {
  scope.establishingLogSink = true;
  try {
    const sink = factory(logPath);
    scope.logSink = sink;
    return sink;
  } catch (error) {
    // A sink's owner that cannot answer has refused the route by failing to produce one. Events leave
    // by stderr, and the next line asks again.
    scope.logSink = undefined;
    reportUndeliverableDiagnosticLine(scope, error);
    return undefined;
  } finally {
    scope.establishingLogSink = false;
  }
}

/**
 * Says why a line could not be written, on a route that does not depend on the file it was for.
 *
 * The warning is an I/O act of its own and can fail too, so every part of it is contained: a line that
 * cannot reach the log is said on stderr, and stderr is not a promise either — a closed pipe makes the whole
 * thing cost nothing.
 *
 * `scope.reportingUndeliverableLine` is set for the whole act, and it is the part that keeps the report from
 * eating the run: the warning is itself an event, and its route is the log route that just failed. Without
 * the flag, appending it would ask the same failing I/O again, once per warning, until the stack gives out.
 * While it stands, `appendDiagnosticLine` sends every line to stderr instead.
 */
function reportUndeliverableDiagnosticLine(scope: DiagnosticsScope, reason: unknown): void {
  const error = reason instanceof Error ? reason.message : String(reason);
  scope.reportingUndeliverableLine = true;
  try {
    emitDiagnostic({
      phase: 'diagnostic_log_write_failed',
      level: 'warn',
      data: { error },
    });
  } catch {
    // The scope's own log route is the thing that just failed; stderr is the answer.
  } finally {
    scope.reportingUndeliverableLine = false;
  }
  writeHostStderrBestEffort(
    `${DIAGNOSTIC_STDERR_PREFIX}${JSON.stringify({ level: 'warn', phase: 'diagnostic_log_write_failed', error })}\n`,
  );
}

/**
 * Makes the directory a plain (unjudged) log path needs, and remembers it did — only once the host says
 * it stands. A directory that failed to be made stays un-remembered, so a later line asks again instead
 * of going quietly blind on a parent that was never created.
 */
function ensureDirectoryForLog(scope: DiagnosticsScope, logPath: string): void {
  const dir = path.dirname(logPath);
  if (scope.ensuredDirectories.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  scope.ensuredDirectories.add(dir);
}

/** Lets go of the sink a scope holds so its descriptor cannot outlive the scope that earned it. */
function closeDiagnosticLineSink(scope: DiagnosticsScope): void {
  const sink = scope.logSink;
  if (!sink) return;
  scope.logSink = undefined;
  try {
    sink.close();
  } catch {
    // Nothing is left to do with a handle the host will not close.
  }
}
