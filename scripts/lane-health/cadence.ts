// Cadence + staleness model for scheduled lanes (issue #1430).
//
// A scheduled lane can stop running — a disabled schedule, a workflow renamed
// out of the trigger, a repo-wide 60-day schedule suspension — while PR CI stays
// green, so nothing fails and nobody notices for weeks. The observatory watches
// the watchers: derive the expected cadence from each workflow's own `cron`, then
// compare it against the last observed run.
//
// Pure model, no IO: `run.ts` supplies the observations from the GitHub API.

/** Hours between fires, derived from a cron expression's coarsest set field. */
export function cadenceHours(cron: string): number {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/);
  if (!minute || !hour) throw new Error(`Unparseable cron: ${cron}`);
  const set = (field: string | undefined): boolean => Boolean(field) && field !== '*';
  if (set(month)) return 24 * 365;
  if (set(dayOfMonth)) return 24 * 30;
  if (set(dayOfWeek)) return 24 * 7;
  if (set(hour)) return 24;
  return 1;
}

/** The cadence of a lane that declares several crons: its most frequent one. */
export function laneCadenceHours(crons: readonly string[]): number {
  const hours = crons.map(cadenceHours);
  if (hours.length === 0) throw new Error('A scheduled lane must declare at least one cron');
  return Math.min(...hours);
}

export type LaneObservation = {
  /** Workflow file name, e.g. `mutation-weekly.yml`. */
  readonly lane: string;
  readonly cadenceHours: number;
  /** ISO timestamp of the most recent scheduled run, or undefined if never. */
  readonly lastRunAt: string | undefined;
  /** ISO timestamp of the most recent successful scheduled run. */
  readonly lastSuccessAt: string | undefined;
  /** Conclusions of recent scheduled runs, newest first. */
  readonly recentConclusions: readonly string[];
  /**
   * When the workflow file was last committed. A lane merged an hour ago has
   * legitimately never run; only one that has been declared for two cadences
   * without firing is dark.
   */
  readonly declaredAt: string | undefined;
};

export type LaneVerdict = {
  readonly lane: string;
  /** `fresh` | `dark` (missed two cadences) | `failing` (two consecutive) | `never-run`. */
  readonly status: 'fresh' | 'dark' | 'failing' | 'never-run';
  readonly detail: string;
};

/**
 * A lane is unhealthy when it misses two consecutive cadences (dark) or fails
 * two consecutive cadences (failing) — one miss is a runner hiccup, two is the
 * lane not doing its job. Both are the alert condition #1430 specifies.
 */
export function evaluateLane(observation: LaneObservation, now: number): LaneVerdict {
  const { lane, cadenceHours: cadence, lastRunAt, recentConclusions, declaredAt } = observation;
  const window = cadence * 2 * 3600_000;
  if (!lastRunAt) {
    const declaredMs = declaredAt ? now - Date.parse(declaredAt) : Number.POSITIVE_INFINITY;
    if (declaredMs <= window) {
      return { lane, status: 'fresh', detail: 'declared recently, awaiting its first run' };
    }
    return { lane, status: 'never-run', detail: 'no scheduled run recorded since it was declared' };
  }
  const ageMs = now - Date.parse(lastRunAt);
  if (ageMs > window) {
    const days = (ageMs / 86_400_000).toFixed(1);
    return {
      lane,
      status: 'dark',
      detail: `last scheduled run ${days}d ago, cadence ${cadence}h (two cadences missed)`,
    };
  }
  const failures = recentConclusions.filter((conclusion) => conclusion !== 'cancelled');
  if (
    failures.length >= 2 &&
    failures.slice(0, 2).every((conclusion) => conclusion !== 'success')
  ) {
    return {
      lane,
      status: 'failing',
      detail: `two consecutive scheduled runs concluded ${failures.slice(0, 2).join(', ')}`,
    };
  }
  return { lane, status: 'fresh', detail: `last scheduled run ${lastRunAt}` };
}

export function unhealthy(verdicts: readonly LaneVerdict[]): LaneVerdict[] {
  return verdicts.filter((verdict) => verdict.status !== 'fresh');
}

export function renderLaneHealth(verdicts: readonly LaneVerdict[]): string {
  const rows = [...verdicts]
    .sort((a, b) => a.lane.localeCompare(b.lane))
    .map((verdict) => `| \`${verdict.lane}\` | ${verdict.status} | ${verdict.detail} |`)
    .join('\n');
  const bad = unhealthy(verdicts);
  const headline =
    bad.length === 0
      ? `All ${verdicts.length} scheduled lane(s) fresh.`
      : `${bad.length} of ${verdicts.length} scheduled lane(s) need attention: ` +
        bad.map((verdict) => verdict.lane).join(', ');
  return `## Scheduled lane health\n\n${headline}\n\n| Lane | Status | Detail |\n| --- | --- | --- |\n${rows}\n`;
}
