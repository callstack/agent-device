import { EXEC_COMMAND_PHASE } from '@agent-device/host-kit/command';
import { DIAGNOSTIC_STDERR_PREFIX } from '@agent-device/host-kit/diagnostics';
import { RETRY_PHASE } from '@agent-device/host-kit/retry';
import { median } from './stats.ts';
import type {
  MeasurementProfile,
  Sample,
  SampleProfile,
  SettleFacts,
  SnapshotFacts,
  Timing,
} from './types.ts';

// The platform-apple façades and the root client export only what production code consumes, so
// these phase names stay literal here.
const RUNNER_COMMAND_SEND_PHASE = 'ios_runner_command_send';
const SNAPSHOT_SOURCE_ACQUIRE_PHASE = 'ios.snapshot-source.acquire';
const SNAPSHOT_SOURCE_RECOVERY_PHASE = 'ios_snapshot_source_recovery';
const DAEMON_REQUEST_PHASE = 'daemon_request';

type DiagnosticEvent = {
  ts?: string;
  level?: string;
  phase?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
};

const STABILIZATION_PHASE = /settle|stabiliz/i;
const FALLBACK_TEXT_LIMIT = 140;

function addTiming(map: Record<string, Timing>, key: string, durationMs: number | undefined): void {
  const entry = (map[key] ??= { count: 0, totalMs: 0 });
  entry.count += 1;
  entry.totalMs += durationMs ?? 0;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, FALLBACK_TEXT_LIMIT)
    : undefined;
}

function eventDuration(event: DiagnosticEvent): number | undefined {
  if (typeof event.durationMs === 'number') return event.durationMs;
  const nested = event.data?.durationMs;
  return typeof nested === 'number' ? nested : undefined;
}

/**
 * Reads one daemon request log (`--debug` ndjson). Process spawns count once, at their `settled`
 * event. Fallbacks name every degraded path the request took: snapshot-source errors, truncated
 * recovery, and warn- or error-level phases.
 */
export function profileRequestLog(ndjson: string): SampleProfile {
  const profile: SampleProfile = {
    phases: {},
    runnerCommands: {},
    spawns: {},
    snapshotSources: {},
    retries: 0,
    stabilization: { count: 0, totalMs: 0 },
    fallbacks: [],
  };
  const fallbacks = new Set<string>();
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    let event: DiagnosticEvent;
    try {
      event = JSON.parse(line) as DiagnosticEvent;
    } catch {
      continue;
    }
    const phase = event.phase;
    if (!phase) continue;
    const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
    if (Number.isFinite(ts)) {
      firstTs ??= ts;
      lastTs = ts;
    }
    const data = event.data ?? {};
    const duration = eventDuration(event);
    if (phase === EXEC_COMMAND_PHASE) {
      if (data.event !== 'settled') continue;
      addTiming(profile.spawns, text(data.command) ?? 'unknown', duration);
    } else if (phase === RUNNER_COMMAND_SEND_PHASE) {
      addTiming(profile.runnerCommands, text(data.command) ?? 'unknown', duration);
    } else if (phase === SNAPSHOT_SOURCE_ACQUIRE_PHASE) {
      const producer = text(data.producer) ?? 'unknown';
      const entry = (profile.snapshotSources[producer] ??= { count: 0, totalMs: 0, failures: 0 });
      entry.count += 1;
      entry.totalMs += duration ?? 0;
      const error = text(data.error);
      if (error || event.level === 'error') {
        entry.failures += 1;
        fallbacks.add(`${producer}: ${error ?? 'failed'}`);
      }
    } else if (phase === SNAPSHOT_SOURCE_RECOVERY_PHASE && data.truncated === true) {
      fallbacks.add(
        `${text(data.producer) ?? 'unknown'}: truncated at ${String(data.acceptedLevels)} levels`,
      );
    } else if (phase === RETRY_PHASE && data.event === 'attempt_failed') {
      profile.retries += 1;
    } else if (event.level === 'warn' || event.level === 'error') {
      fallbacks.add(`${phase}${text(data.reason) ? `: ${text(data.reason)}` : ''}`);
    }
    if (STABILIZATION_PHASE.test(phase)) {
      profile.stabilization.count += 1;
      profile.stabilization.totalMs += duration ?? 0;
    }
    addTiming(profile.phases, phase, duration);
  }
  profile.fallbacks = [...fallbacks].sort();
  if (firstTs !== undefined && lastTs !== undefined) profile.requestSpanMs = lastTs - firstTs;
  return profile;
}

/** Reads the client's `daemon_request` timer and request id from `--debug` stderr. */
export function readClientDiagnostics(stderr: string): { daemonMs?: number; requestId?: string } {
  for (const line of stderr.split('\n')) {
    const start = line.indexOf(DIAGNOSTIC_STDERR_PREFIX);
    if (start < 0) continue;
    try {
      const event = JSON.parse(line.slice(start + DIAGNOSTIC_STDERR_PREFIX.length)) as {
        phase?: string;
        durationMs?: number;
        requestId?: string;
      };
      if (event.phase === DAEMON_REQUEST_PHASE) {
        return { daemonMs: event.durationMs, requestId: event.requestId };
      }
    } catch {
      // A truncated diagnostic line carries no timer.
    }
  }
  return {};
}

/** Reads the settle outcome of a `--settle` response. */
export function readSettleFacts(json: unknown): SettleFacts | undefined {
  const settle = (json as { data?: { settle?: Record<string, unknown> } } | undefined)?.data
    ?.settle;
  if (!settle || typeof settle.waitedMs !== 'number') return undefined;
  return {
    waitedMs: settle.waitedMs,
    captures: typeof settle.captures === 'number' ? settle.captures : undefined,
    settled: typeof settle.settled === 'boolean' ? settle.settled : undefined,
  };
}

/** Reads snapshot quality facts from a `--json` snapshot response. */
export function readSnapshotFacts(json: unknown): SnapshotFacts | undefined {
  const data = (json as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data || !Array.isArray(data.nodes)) return undefined;
  const nodes = data.nodes as { depth?: unknown }[];
  const quality = (data.snapshotQuality ?? {}) as Record<string, unknown>;
  const depths = nodes.map((node) => (typeof node.depth === 'number' ? node.depth : 0));
  return {
    backend: text(quality.backend),
    state: text(quality.state),
    reasonCode: text(quality.reasonCode),
    nodeCount: nodes.length,
    maxDepth: depths.length > 0 ? Math.max(...depths) : undefined,
    truncated: typeof data.truncated === 'boolean' ? data.truncated : undefined,
  };
}

function medianOrNull(values: number[]): number | null {
  return values.length === 0 ? null : median(values);
}

function sumTimings(map: Record<string, Timing>): Timing {
  return Object.values(map).reduce(
    (sum, t) => ({ count: sum.count + t.count, totalMs: sum.totalMs + t.totalMs }),
    { count: 0, totalMs: 0 },
  );
}

function tally(counts: Record<string, number>, keys: Iterable<string>): void {
  for (const key of new Set(keys)) counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Summarizes the successful samples' profiles. Medians describe a typical request; producers,
 * backends, and fallbacks count how many samples took each path.
 */
export function aggregateProfiles(samples: Sample[]): MeasurementProfile | null {
  const profiled = samples.filter((s) => s.ok && s.profile);
  if (profiled.length === 0) return null;
  const profiles = profiled.map((s) => s.profile!);
  const producers: Record<string, number> = {};
  const backends: Record<string, number> = {};
  const fallbacks: Record<string, number> = {};
  for (const sample of profiled) {
    const profile = sample.profile!;
    tally(
      producers,
      Object.entries(profile.snapshotSources)
        .filter(([, source]) => source.count > source.failures)
        .map(([producer]) => producer),
    );
    if (profile.runnerCommands.snapshot) tally(producers, ['apple-runner']);
    if (sample.snapshot?.backend) {
      const { backend, state, reasonCode } = sample.snapshot;
      tally(backends, [[backend, state, reasonCode].filter(Boolean).join('/')]);
    }
    tally(fallbacks, profile.fallbacks);
  }
  const phaseNames = new Set(profiles.flatMap((p) => Object.keys(p.phases)));
  const topPhases = [...phaseNames]
    .map((phase) => ({
      phase,
      medianMs: median(profiles.map((p) => p.phases[phase]?.totalMs ?? 0)),
    }))
    .filter((entry) => entry.medianMs > 0)
    .sort((a, b) => b.medianMs - a.medianMs)
    .slice(0, 5);
  return {
    runnerMs: medianOrNull(profiles.map((p) => sumTimings(p.runnerCommands).totalMs)),
    spawnCount: medianOrNull(profiles.map((p) => sumTimings(p.spawns).count)),
    spawnMs: medianOrNull(profiles.map((p) => sumTimings(p.spawns).totalMs)),
    snapshotSourceMs: medianOrNull(profiles.map((p) => sumTimings(p.snapshotSources).totalMs)),
    stabilizationMs: medianOrNull(profiles.map((p) => p.stabilization.totalMs)),
    settleWaitMs: medianOrNull(profiled.flatMap((s) => (s.settle ? [s.settle.waitedMs] : []))),
    retries: profiles.reduce((sum, p) => sum + p.retries, 0),
    producers,
    backends,
    fallbacks,
    topPhases,
  };
}
