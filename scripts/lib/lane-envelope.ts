// Standard artifact envelope for scheduled lanes (issue #1430).
//
// A scheduled lane can go dark or drift for weeks while PR CI stays green, so
// every artifact it uploads must say — without a human reading logs — which
// commit produced it, which tool/config version measured it, how long it took,
// and whether it passed. Freshness monitoring reads `finishedAt`/`result`; drift
// analysis reads `tool`/`configHash`.
//
// Lanes that adopt the envelope later should import this module rather than
// re-deriving the field names.

export const LANE_ENVELOPE_SCHEMA_VERSION = 1;

export type LaneResult = 'pass' | 'fail';

export type LaneEnvelope<T> = {
  schemaVersion: number;
  /** Stable lane id — the metric key freshness/health jobs group by. */
  lane: string;
  commit: string;
  ref: string | undefined;
  runUrl: string | undefined;
  /** Tool versions, or content hashes where a version is not enough. */
  tool: Record<string, string>;
  configHash: string;
  /** Only lanes with randomized input record a seed; `null` states "not applicable". */
  seed: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: LaneResult;
  /** Lane-specific payload; kept separate so the envelope shape stays stable. */
  data: T;
};

export type LaneEnvelopeInput<T> = {
  lane: string;
  commit: string;
  tool: Record<string, string>;
  configHash: string;
  startedAtMs: number;
  result: LaneResult;
  data: T;
  seed?: string | null;
  now?: number;
};

export function laneEnvelope<T>(input: LaneEnvelopeInput<T>): LaneEnvelope<T> {
  const finished = input.now ?? Date.now();
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_REF_NAME } = process.env;
  return {
    schemaVersion: LANE_ENVELOPE_SCHEMA_VERSION,
    lane: input.lane,
    commit: input.commit,
    ref: GITHUB_REF_NAME,
    runUrl:
      GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
        ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : undefined,
    tool: input.tool,
    configHash: input.configHash,
    seed: input.seed ?? null,
    startedAt: new Date(input.startedAtMs).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - input.startedAtMs),
    result: input.result,
    data: input.data,
  };
}
