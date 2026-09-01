import type {
  CandidateId,
  LifecycleEvidence,
  PreferenceEvidence,
  ResourceLimits,
  SpikeCell,
} from './types.ts';
import { LOCAL_STATES, SCREEN_FIXTURES } from '../ios-snapshot-benchmark/definitions.ts';

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
  const evaluated = (['public-macos-ax', 'private-coresimulator-ax'] as const).flatMap(
    (candidate) => {
      const candidateCells = cells.filter((cell) => cell.candidate === candidate);
      const candidateProbes = probes.filter((probe) => probe.candidate === candidate);
      if (candidateCells.length === 0 && candidateProbes.length === 0) return [];
      const coreReasons = [
        ...probeReasons(candidateProbes),
        ...candidateDecisionReasons(candidateCells, limits),
      ];
      return [
        {
          candidate,
          reasons:
            coreReasons.length > 0
              ? coreReasons
              : candidateCompletenessReasons(candidate, candidateCells),
        },
      ];
    },
  );
  if (evaluated.some((candidate) => candidate.reasons.length === 0)) return [];
  if (evaluated.length === 0) return ['No bridge candidate produced evidence.'];
  return evaluated.flatMap((candidate) => candidate.reasons);
}

function probeReasons(
  probes: readonly { candidate: CandidateId; failure?: { kind: string; code?: string } }[],
): string[] {
  return probes.flatMap((probe) =>
    probe.failure
      ? [
          `${probe.candidate} protocol probe returned ${probe.failure.kind}/${probe.failure.code ?? 'no-code'}.`,
        ]
      : [],
  );
}

const REQUIRED_STATES = LOCAL_STATES;
const REQUIRED_SCREENS = SCREEN_FIXTURES.map((fixture) => fixture.id);

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
  reasons.push(...candidateAvailabilityReasons(cells));
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
    reasons.push(`${cell.candidate} warm acquisition missed the 75/150 ms target.`);
  }
  return reasons;
}

function candidateAvailabilityReasons(cells: readonly SpikeCell[]): string[] {
  const reasons: string[] = [];
  if (cells.some(hasUnavailablePrivateTool)) {
    reasons.push('The private CoreSimulator AX mechanism has no configured tool on this host.');
  }
  if (cells.some(hasUnsupportedPublicAx)) {
    reasons.push(
      'The public macOS AX mechanism was unsupported or unreadable on the host Simulator surface.',
    );
  }
  return reasons;
}

function hasUnavailablePrivateTool(cell: SpikeCell): boolean {
  return (
    cell.candidate === 'private-coresimulator-ax' &&
    cell.acquisitionSamples.some((sample) => sample.failure?.code === 'private-tool-unavailable')
  );
}

function hasUnsupportedPublicAx(cell: SpikeCell): boolean {
  return (
    cell.candidate === 'public-macos-ax' &&
    cell.acquisitionSamples.some((sample) => sample.failure?.kind === 'unsupported-mechanism')
  );
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
