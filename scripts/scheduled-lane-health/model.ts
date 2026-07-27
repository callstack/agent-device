// Pure logic for the scheduled-lane health watcher (#1430, umbrella #1412
// Track E — "the observatory must watch the watchers").
//
// Scheduled lanes (nightly torture/replay/perf/conformance sweeps) can fail or
// stop running for weeks while PR CI stays green. This model turns two derived
// inputs — the `schedule:`-triggered workflows discovered from `.github/
// workflows/` (never hand-maintained) and each workflow's recent scheduled runs
// from the GitHub API — into a health verdict, and alerts when a lane misses or
// fails two consecutive cadences. All I/O (disk, GitHub API, issue creation)
// lives in `run.ts`; this file is pure and unit-tested.

import { parse } from 'yaml';

export type ScheduledLane = {
  /** Workflow file name, e.g. `concurrency-torture-nightly.yml`. */
  file: string;
  /** Workflow `name:` (falls back to the file name). */
  name: string;
  /** Estimated interval between scheduled fires, in milliseconds. */
  cadenceMs: number;
};

export type LaneRun = {
  conclusion: string | null;
  /** ISO timestamp the run was created. */
  createdAt: string;
};

export type LaneHealth = {
  file: string;
  name: string;
  healthy: boolean;
  reason: string;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Expand a single cron field (e.g. `*`, `5`, `1,15`, `*​/6`, `0-4`) into the set
 * of matching integer values within [min, max]. Unknown syntax expands to the
 * full range so we never under-count fires (which would hide a stale lane).
 */
export function expandCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const expanded = expandCronPart(part, min, max);
    if (expanded === 'full') return range(min, max); // fail open — never under-count
    for (const value of expanded) values.add(value);
  }
  return values.size > 0 ? [...values] : range(min, max);
}

/** Expand one comma-separated cron part, or `'full'` if its syntax is unknown. */
function expandCronPart(part: string, min: number, max: number): number[] | 'full' {
  const [rangePart, stepPart] = part.split('/');
  const step = stepPart ? Number(stepPart) : 1;
  if (!Number.isInteger(step) || step <= 0) return 'full';
  const bounds = parseRangeBounds(rangePart, min, max);
  if (!bounds) return 'full';
  const out: number[] = [];
  for (let v = bounds.lo; v <= bounds.hi; v += step) {
    if (v >= min && v <= max) out.push(v);
  }
  return out;
}

function parseRangeBounds(
  rangePart: string,
  min: number,
  max: number,
): { lo: number; hi: number } | undefined {
  if (!rangePart || rangePart === '*') return { lo: min, hi: max };
  const [a, b] = rangePart.split('-');
  const lo = Number(a);
  const hi = b === undefined ? Number(a) : Number(b);
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return undefined;
  return { lo, hi };
}

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/**
 * Estimate the interval between consecutive fires of a 5-field cron expression
 * by counting fires over a representative 28-day window. Exact enough to detect
 * "missed two cadences" for daily/weekly/hourly/stepped schedules; day-of-month
 * and day-of-week use Vixie-cron OR semantics when both are restricted.
 */
export function cronCadenceMs(cron: string): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return DAY_MS; // unknown shape → assume daily
  const [minF, hourF, domF, monF, dowF] = fields;
  const minutes = expandCronField(minF, 0, 59);
  const hours = expandCronField(hourF, 0, 23);
  const doms = new Set(expandCronField(domF, 1, 31));
  const months = new Set(expandCronField(monF, 1, 12));
  const dows = new Set(expandCronField(dowF, 0, 6).map((d) => (d === 7 ? 0 : d)));
  const domRestricted = domF !== '*';
  const dowRestricted = dowF !== '*';

  const windowDays = 28;
  const start = new Date(Date.UTC(2001, 0, 1)); // Monday-anchored reference window
  let fires = 0;
  for (let day = 0; day < windowDays; day += 1) {
    const date = new Date(start.getTime() + day * DAY_MS);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const domMatch = doms.has(date.getUTCDate());
    const dowMatch = dows.has(date.getUTCDay());
    // Vixie cron: when BOTH day fields are restricted, either match fires.
    const dayMatch =
      domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (dayMatch) fires += hours.length * minutes.length;
  }
  if (fires === 0) return windowDays * DAY_MS;
  return Math.round((windowDays * DAY_MS) / fires);
}

/**
 * Parse a workflow file's YAML and, if it is `schedule:`-triggered, return its
 * lane descriptor with a cadence derived from the shortest cron interval.
 * Returns undefined for non-scheduled (or unparseable) workflows.
 */
export function parseScheduledLane(file: string, content: string): ScheduledLane | undefined {
  let doc: unknown;
  try {
    doc = parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(doc)) return undefined;
  // `on` is a YAML boolean-ish key; the parser may surface it as `on` or `true`.
  const on = doc.on ?? (doc as Record<string, unknown>).true;
  if (!isRecord(on)) return undefined;
  const schedule = on.schedule;
  if (!Array.isArray(schedule)) return undefined;
  const crons = schedule
    .map((entry) => (isRecord(entry) && typeof entry.cron === 'string' ? entry.cron : undefined))
    .filter((cron): cron is string => typeof cron === 'string');
  if (crons.length === 0) return undefined;
  const cadenceMs = Math.min(...crons.map(cronCadenceMs));
  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : file;
  return { file, name, cadenceMs };
}

/**
 * Discover every scheduled lane from a set of workflow files, excluding the
 * watcher's own workflow so it never alerts on itself.
 */
export function discoverScheduledLanes(
  files: readonly { file: string; content: string }[],
  selfFile: string,
): ScheduledLane[] {
  const lanes: ScheduledLane[] = [];
  for (const { file, content } of files) {
    if (file === selfFile) continue;
    const lane = parseScheduledLane(file, content);
    if (lane) lanes.push(lane);
  }
  return lanes.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * A lane is unhealthy when it has not SUCCEEDED within two of its own cadences —
 * which captures both a lane that went dark (no runs at all) and one that has
 * been failing every cadence. `runs` are that lane's scheduled runs, newest
 * first is not required.
 */
export function evaluateLaneHealth(params: {
  lane: ScheduledLane;
  runs: readonly LaneRun[];
  now: number;
}): LaneHealth {
  const { lane, runs, now } = params;
  const staleAfterMs = 2 * lane.cadenceMs;
  const base = { file: lane.file, name: lane.name };
  const cadences = describeCadence(lane.cadenceMs);

  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const lastSuccess = sorted.find((run) => run.conclusion === 'success');

  if (!lastSuccess) {
    const lastConclusion = sorted[0]?.conclusion ?? 'no runs';
    return {
      ...base,
      healthy: false,
      reason:
        sorted.length === 0
          ? `no scheduled runs recorded (expected roughly every ${cadences})`
          : `no successful scheduled run on record (latest: ${lastConclusion}) — failing every cadence (~${cadences})`,
    };
  }

  const ageMs = now - new Date(lastSuccess.createdAt).getTime();
  if (ageMs > staleAfterMs) {
    return {
      ...base,
      healthy: false,
      reason: `last success ${formatAge(ageMs)} ago, older than two cadences (~${cadences} each) — lane has missed or failed two consecutive cadences`,
    };
  }

  return {
    ...base,
    healthy: true,
    reason: `last success ${formatAge(ageMs)} ago (within two cadences of ~${cadences})`,
  };
}

/** Title of the single tracking issue this watcher opens/pings. */
export const ALERT_ISSUE_TITLE = 'Scheduled lane health: a lane missed or failed two cadences';

/**
 * Build the alert issue/comment body from the unhealthy lanes. Returns undefined
 * when every lane is healthy (nothing to alert).
 */
export function buildAlertBody(params: {
  healths: readonly LaneHealth[];
  now: number;
  runUrl?: string;
}): string | undefined {
  const unhealthy = params.healths.filter((h) => !h.healthy);
  if (unhealthy.length === 0) return undefined;
  const lines = [
    `**${unhealthy.length} scheduled lane(s)** have missed or failed two consecutive cadences as of ${new Date(params.now).toISOString()}.`,
    '',
    'A green PR CI does not cover these lanes — this watcher (#1430) exists so they cannot silently go dark.',
    '',
    ...unhealthy.map((h) => `- \`${h.file}\` (${h.name}): ${h.reason}`),
  ];
  if (params.runUrl) {
    lines.push('', `_Reported by ${params.runUrl}_`);
  }
  return lines.join('\n');
}

function describeCadence(cadenceMs: number): string {
  if (cadenceMs >= DAY_MS) return `${round(cadenceMs / DAY_MS)}d`;
  if (cadenceMs >= HOUR_MS) return `${round(cadenceMs / HOUR_MS)}h`;
  return `${round(cadenceMs / MINUTE_MS)}m`;
}

function formatAge(ms: number): string {
  if (ms >= DAY_MS) return `${round(ms / DAY_MS)}d`;
  if (ms >= HOUR_MS) return `${round(ms / HOUR_MS)}h`;
  return `${round(ms / MINUTE_MS)}m`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
