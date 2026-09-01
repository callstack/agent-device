import type {
  CandidateId,
  LifecycleEvidence,
  PreferenceEvidence,
  ResourceLimits,
  SpikeCell,
} from './types.ts';
import { parseLocalStates, parseScreenIds } from '../ios-snapshot-benchmark/definitions.ts';

export function decideSpike(
  cells: readonly SpikeCell[],
  lifecycle: LifecycleEvidence,
  preferences: PreferenceEvidence,
  limits: ResourceLimits,
  status: 'completed' | 'stopped' = 'completed',
  protocolProbes: readonly {
    candidate: CandidateId;
    failure?: { kind: string; code?: string };
  }[] = [],
): { decision: 'GO' | 'NO-GO'; reasons: string[] } {
  const reasons = [
    ...statusReasons(status),
    ...preferenceReasons(preferences),
    ...bridgeRouteReasons(cells, protocolProbes, limits),
    ...lifecycleReasons(lifecycle),
  ];
  const uniqueReasons = [...new Set(reasons)];
  return {
    decision: uniqueReasons.length === 0 ? 'GO' : 'NO-GO',
    reasons: uniqueReasons,
  };
}

function statusReasons(status: 'completed' | 'stopped'): string[] {
  return status === 'stopped' ? ['The live run stopped before the full corpus completed.'] : [];
}

function preferenceReasons(preferences: PreferenceEvidence): string[] {
  if (!preferences.applied)
    return ['The required task-owned Simulator preference experiment was not run.'];
  if (!preferences.restored)
    return ['The task-owned Simulator preference experiment was not restored.'];
  if (preferences.fixtureLaunchCompatible === false)
    return ['The task-owned Simulator preference experiment prevented the fixture from launching.'];
  return [];
}

function bridgeRouteReasons(
  cells: readonly SpikeCell[],
  probes: readonly { candidate: CandidateId; failure?: { kind: string; code?: string } }[],
  limits: ResourceLimits,
): string[] {
  const candidate = 'guest-simulator-framework-bridge' as const;
  const candidateCells = cells.filter((cell) => cell.candidate === candidate);
  const candidateProbes = probes.filter((probe) => probe.candidate === candidate);
  if (candidateCells.length === 0 && candidateProbes.length === 0) {
    return ['No guest SimulatorFrameworkBridge candidate produced evidence.'];
  }
  const coreReasons = [
    ...probeReasons(candidateProbes),
    ...candidateDecisionReasons(candidateCells, limits),
  ];
  return coreReasons.length > 0
    ? coreReasons
    : candidateCompletenessReasons(candidate, candidateCells);
}

function probeReasons(
  probes: readonly { candidate: CandidateId; failure?: { kind: string; code?: string } }[],
): string[] {
  return probes.flatMap((probe) =>
    probe.failure && !isReadinessProbeFailure(probe.failure.code)
      ? [
          `${probe.candidate} protocol probe returned ${probe.failure.kind}/${probe.failure.code ?? 'no-code'}.`,
        ]
      : [],
  );
}

function isReadinessProbeFailure(code: string | undefined): boolean {
  return [
    'target-application-unavailable',
    'target-has-no-accessibility-windows',
    'target-simulator-window-unavailable',
    'target-simulator-content-unavailable',
    'batch-duration-limit',
  ].includes(code ?? '');
}

const REQUIRED_STATES = parseLocalStates(undefined);
const REQUIRED_SCREENS = parseScreenIds(undefined);

function candidateCompletenessReasons(
  candidate: Exclude<CandidateId, 'xctest-control'>,
  cells: readonly SpikeCell[],
): string[] {
  if (cells.length === 0) return [`${candidate} produced no cells.`];
  const observed = new Set(cells.map((cell) => `${cell.state}/${cell.screen}`));
  const missing = REQUIRED_STATES.flatMap((state) =>
    REQUIRED_SCREENS.flatMap((screen) =>
      observed.has(`${state}/${screen}`) ? [] : [`${state}/${screen}`],
    ),
  );
  if (missing.length === 0) return [];
  return [`${candidate} did not complete the required corpus (${missing.length} cells missing).`];
}

function lifecycleReasons(lifecycle: LifecycleEvidence): string[] {
  const checks = [
    ['process crash', lifecycle.crash, 'process-crash'],
    ['timeout', lifecycle.timeout, 'timeout'],
    ['cancellation', lifecycle.cancellation, 'cancelled'],
    ['stale target-generation', lifecycle.staleGeneration, 'stale-generation'],
  ] as const;
  const reasons: string[] = [];
  for (const [label, result, expected] of checks) {
    if (result.failure === expected && result.recovered) continue;
    reasons.push(
      `Framed ${label} recovery did not produce the required typed result and recovery.`,
    );
  }
  return reasons;
}

function candidateDecisionReasons(cells: readonly SpikeCell[], limits: ResourceLimits): string[] {
  const reasons: string[] = [];
  for (const cell of cells) {
    reasons.push(...sampleShapeReasons(cell));
    reasons.push(...resourceReasons(cell, limits));
    reasons.push(...latencyReasons(cell));
  }
  return [...new Set(reasons)];
}

function sampleShapeReasons(cell: SpikeCell): string[] {
  const samples = cell.acquisitionSamples;
  const successful = samples.filter((sample) => sample.ok && sample.firstTree === 'readable');
  const reasons: string[] = [];
  if (successful.length < cell.sampleMinimum) {
    reasons.push(
      `${cell.candidate} ${cell.state}/${cell.screen} did not produce ${cell.sampleMinimum} readable samples.`,
    );
  }
  if (
    samples.some((sample) => ['unreadable', 'empty', 'not-observed'].includes(sample.firstTree))
  ) {
    reasons.push(
      `${cell.candidate} ${cell.state}/${cell.screen} has unreadable or empty first-tree evidence.`,
    );
  }
  if (samples.some((sample) => sample.failure?.kind === 'stale-generation')) {
    reasons.push(
      `${cell.candidate} ${cell.state}/${cell.screen} has stale-generation acquisition evidence.`,
    );
  }
  if (samples.some((sample) => sample.acquisition?.truncated === true)) {
    reasons.push(
      `${cell.candidate} ${cell.state}/${cell.screen} published truncated acquisition facts.`,
    );
  }
  if (
    samples.some(
      (sample) =>
        sample.ok &&
        sample.acquisition !== undefined &&
        sample.acquisition.targetGeneration === null,
    )
  ) {
    reasons.push(
      `${cell.candidate} ${cell.state}/${cell.screen} did not report a target generation for a successful acquisition.`,
    );
  }
  return reasons;
}

function resourceReasons(cell: SpikeCell, limits: ResourceLimits): string[] {
  const checks = [
    [
      'duration',
      limits.maxDurationMs,
      (sample: SpikeCell['acquisitionSamples'][number]) => sample.metrics?.durationMs,
    ],
    [
      'CPU',
      limits.maxCpuMs,
      (sample: SpikeCell['acquisitionSamples'][number]) => sample.metrics?.cpuMs,
    ],
    [
      'memory',
      limits.maxMemoryBytes,
      (sample: SpikeCell['acquisitionSamples'][number]) => sample.metrics?.memoryBytes,
    ],
  ] as const;
  const reasons: string[] = [];
  if (
    cell.acquisitionSamples.some(
      (sample) =>
        sample.failure?.kind === 'timeout' || sample.failure?.code === 'batch-duration-limit',
    )
  ) {
    reasons.push(`${cell.candidate} ${cell.state}/${cell.screen} exceeded the duration bound.`);
  }
  for (const [label, limit, readValue] of checks) {
    if (cell.acquisitionSamples.some((sample) => exceedsLimit(readValue(sample), limit))) {
      reasons.push(`${cell.candidate} ${cell.state}/${cell.screen} exceeded the ${label} bound.`);
    }
  }
  return reasons;
}

function latencyReasons(cell: SpikeCell): string[] {
  const successful = cell.acquisitionSamples.filter(
    (sample) => sample.ok && sample.firstTree === 'readable',
  );
  const firstLook = finite(successful.map((sample) => sample.firstLookMs));
  const firstLookTarget = {
    'cold-cold': { limit: 5_000, label: 'cold-cold first look missed the 5 second target.' },
    cold: { limit: 1_500, label: 'cold prepared first look missed the 1.5 second target.' },
    relaunch: { limit: 250, label: 'relaunch first look missed the 250 ms target.' },
    warm: undefined,
  }[cell.state];
  const reasons: string[] = [];
  if (firstLookTarget && percentile(firstLook, 95) >= firstLookTarget.limit) {
    reasons.push(`${cell.candidate} ${firstLookTarget.label}`);
  }
  const acquisition = finite(successful.map((sample) => sample.metrics?.durationMs));
  if (
    cell.state === 'warm' &&
    (percentile(acquisition, 50) >= 75 || percentile(acquisition, 95) >= 150)
  ) {
    reasons.push(
      `${cell.candidate} ${cell.state}/${cell.screen} acquisition missed the 75/150 ms target.`,
    );
  }
  return reasons;
}

function exceedsLimit(value: number | null | undefined, limit: number): boolean {
  return value !== null && value !== undefined && value > limit;
}

function finite(values: readonly (number | undefined)[]): number[] {
  return values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

function percentile(values: readonly number[], percentage: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentage / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}
