import { buildMeasurement } from './measurement.ts';
import { PERF_SUMMARY_SCHEMA, type Measurement, type PerfSummary, type Sample } from './types.ts';

export type StepFixture = {
  id: string;
  // Daemon round trips of the successful samples; wall adds a fixed CLI overhead.
  daemonMs?: number[];
  wallMs?: number[];
  failures?: number;
};

function measurement(step: StepFixture): Measurement {
  const timings = step.daemonMs ?? step.wallMs ?? [];
  const samples: Sample[] = timings.map((ms, round) => ({
    round,
    ok: true,
    wallClockMs: step.daemonMs ? ms + 300 : ms,
    daemonMs: step.daemonMs ? ms : undefined,
  }));
  for (let i = 0; i < (step.failures ?? 0); i++) {
    samples.push({ round: samples.length, ok: false, wallClockMs: 0, errorCode: 'COMMAND_FAILED' });
  }
  const [scenario] = step.id.split('/');
  return buildMeasurement({
    id: step.id,
    scenario: scenario!,
    label: step.id,
    command: 'snapshot',
    args: [],
    platform: 'ios',
    execMode: 'standalone',
    samples,
    warmupDropped: 1,
  });
}

/** A schema-valid summary whose steps carry the given timings. */
export function summaryFixture(
  steps: StepFixture[],
  overrides: { startedAt?: string; xcode?: string; runId?: string } = {},
): PerfSummary {
  return {
    schema: PERF_SUMMARY_SCHEMA,
    platform: 'ios',
    startedAt: overrides.startedAt ?? '2026-10-20T03:00:00.000Z',
    finishedAt: '2026-10-20T03:30:00.000Z',
    config: {
      rounds: 5,
      warmup: 1,
      scenarios: [...new Set(steps.map((s) => s.id.split('/')[0]!))],
    },
    metadata: {
      commit: '0123456789abcdef',
      dirty: false,
      runId: overrides.runId,
      agentDeviceVersion: '0.0.0',
      host: { os: 'Darwin', arch: 'arm64', cpu: 'Apple M1 (Virtual)', cores: 3, memoryGb: 7 },
      xcode: overrides.xcode ?? 'Xcode 26.2',
      node: 'v24.0.0',
      device: { name: 'iPhone 17 Pro', runtime: 'iOS-26-2' },
    },
    coverage: { measured: ['snapshot'], excluded: [] },
    measurements: steps.map(measurement),
  };
}
