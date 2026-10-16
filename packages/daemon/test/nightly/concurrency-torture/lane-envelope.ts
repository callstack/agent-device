const LANE_ENVELOPE_SCHEMA_VERSION = 1;

export type LaneResult = 'pass' | 'fail';

export type LaneEnvelope<T> = {
  schemaVersion: number;
  lane: string;
  commit: string;
  ref: string | undefined;
  runUrl: string | undefined;
  tool: Record<string, string>;
  configHash: string;
  seed: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: LaneResult;
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
