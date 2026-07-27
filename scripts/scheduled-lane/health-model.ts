// Health classification for scheduled lanes (#1430).
//
// The rule the observatory exists for: a lane that stops running looks exactly like a lane that
// never fails. Classification is therefore derived from recorded run fields (conclusion, timestamp)
// and the declared cadence — never from log or error text — so it stays honest when a lane goes
// dark rather than red.

export type LaneCadence = {
  /** Workflow file name, e.g. `replays-nightly.yml`. */
  workflow: string;
  name: string;
  cronExpressions: string[];
  cadenceHours: number;
};

export type LaneRun = {
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'other' | null;
  createdAt: string;
  url: string;
};

/** `pending` covers a lane with no history to judge: not on the default branch yet, or no token. */
export type LaneState = 'healthy' | 'failing' | 'dark' | 'pending';

export type LaneHistory = {
  /** False when the run history could not be read at all, which is not evidence of a dark lane. */
  known: boolean;
  reason?: string;
  /** Newest-first, as the GitHub runs API returns them. */
  runs: readonly LaneRun[];
};

export type LaneHealth = LaneCadence & {
  state: LaneState;
  reason: string;
  lastRunAt: string | null;
  lastRunUrl: string | null;
  lastSuccessAt: string | null;
  hoursSinceLastRun: number | null;
  hoursSinceLastSuccess: number | null;
  consecutiveFailures: number;
};

/** A lane is dark or failing only after it misses/fails this many cadences in a row. */
const CADENCES_BEFORE_ALERT = 2;

const HOUR_MS = 60 * 60 * 1000;

function fieldValues(field: string, max: number): number {
  if (field === '*') return max;
  return field.split(',').reduce((count, part) => {
    const step = part.includes('/') ? Number(part.split('/')[1]) : 1;
    const span = part.startsWith('*') ? max : 1;
    return count + Math.max(1, Math.floor(span / (Number.isFinite(step) ? step : 1)));
  }, 0);
}

/**
 * Cadence of a five-field cron in hours. Deliberately coarse — it only has to be right enough to
 * decide "should this lane have run by now", and a wrong-by-an-hour cadence never fires an alert
 * on its own (see CADENCES_BEFORE_ALERT).
 */
function cadenceHoursForCron(expression: string): number {
  const [, hour = '*', dayOfMonth = '*', , dayOfWeek = '*'] = expression.trim().split(/\s+/);
  const perDay = fieldValues(hour, 24);
  if (dayOfWeek !== '*' || dayOfMonth !== '*') return (7 * 24) / perDay;
  return 24 / perDay;
}

/** The tightest cadence wins: that is the interval a run is expected within. */
export function cadenceHours(cronExpressions: readonly string[]): number {
  const hours = cronExpressions.map(cadenceHoursForCron);
  return hours.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...hours);
}

function hoursSince(iso: string | null, now: number): number | null {
  return iso === null ? null : (now - Date.parse(iso)) / HOUR_MS;
}

function countLeadingFailures(runs: readonly LaneRun[]): number {
  const failed = runs.findIndex((run) => run.conclusion === 'success');
  return failed === -1 ? runs.length : failed;
}

function classify(input: {
  runs: readonly LaneRun[];
  cadenceHours: number;
  hoursSinceLastRun: number | null;
  consecutiveFailures: number;
}): { state: LaneState; reason: string } {
  const budget = input.cadenceHours * CADENCES_BEFORE_ALERT;
  if (input.runs.length === 0) return { state: 'dark', reason: 'no scheduled run recorded yet' };
  if (input.hoursSinceLastRun !== null && input.hoursSinceLastRun > budget) {
    return {
      state: 'dark',
      reason: `last run ${input.hoursSinceLastRun.toFixed(1)}h ago, over ${budget}h of cadence`,
    };
  }
  if (input.consecutiveFailures >= CADENCES_BEFORE_ALERT) {
    return {
      state: 'failing',
      reason: `${input.consecutiveFailures} consecutive scheduled runs failed`,
    };
  }
  return { state: 'healthy', reason: 'ran within cadence, last run succeeded or failed once' };
}

export function laneHealth(cadence: LaneCadence, history: LaneHistory, now: number): LaneHealth {
  const runs = history.runs;
  const lastRun = runs[0] ?? null;
  const lastSuccess = runs.find((run) => run.conclusion === 'success') ?? null;
  const hoursSinceLastRun = hoursSince(lastRun?.createdAt ?? null, now);
  const consecutiveFailures = countLeadingFailures(runs);
  return {
    ...cadence,
    ...(history.known
      ? classify({
          runs,
          cadenceHours: cadence.cadenceHours,
          hoursSinceLastRun,
          consecutiveFailures,
        })
      : {
          state: 'pending' as const,
          reason: history.reason ?? 'no scheduled run history available',
        }),
    lastRunAt: lastRun?.createdAt ?? null,
    lastRunUrl: lastRun?.url ?? null,
    lastSuccessAt: lastSuccess?.createdAt ?? null,
    hoursSinceLastRun,
    hoursSinceLastSuccess: hoursSince(lastSuccess?.createdAt ?? null, now),
    consecutiveFailures,
  };
}

/** Only states with evidence behind them alert; `pending` never wakes anyone up. */
export function unhealthyLanes(lanes: readonly LaneHealth[]): LaneHealth[] {
  return lanes.filter((lane) => lane.state === 'dark' || lane.state === 'failing');
}

/** One markdown row per lane; the same table goes to the step summary and the alert issue. */
export function healthTable(lanes: readonly LaneHealth[]): string {
  const rows = lanes.map((lane) => {
    const since =
      lane.hoursSinceLastSuccess === null ? 'never' : `${lane.hoursSinceLastSuccess.toFixed(1)}h`;
    return `| ${lane.name} | \`${lane.workflow}\` | ${lane.state} | every ${lane.cadenceHours}h | ${since} | ${lane.reason} |`;
  });
  return [
    '| Lane | Workflow | State | Cadence | Since last success | Why |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
