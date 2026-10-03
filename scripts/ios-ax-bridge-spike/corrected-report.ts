import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  CorrectedReport,
  GateResult,
  LatencySummary,
  TargetedRawArtifact,
} from './corrected-types.ts';
import { renderCorrectedMarkdown } from './corrected-markdown.ts';
import type { SpikeCell, SpikeReport } from './types.ts';

export function readSpikeReport(filePath: string): SpikeReport {
  return JSON.parse(gunzipSync(fs.readFileSync(filePath)).toString('utf8')) as SpikeReport;
}

export function readTargetedArtifact(filePath: string): TargetedRawArtifact {
  return JSON.parse(gunzipSync(fs.readFileSync(filePath)).toString('utf8')) as TargetedRawArtifact;
}

export function buildCorrectedReport(options: {
  sourcePath: string;
  source: SpikeReport;
  targetedPath: string;
  targeted: TargetedRawArtifact;
}): CorrectedReport {
  const readiness = [
    ...options.source.cells
      .filter(
        (cell) => cell.candidate === 'guest-simulator-framework-bridge' && cell.state === 'warm',
      )
      .map(summarizeLatency),
    ...summarizeTargetedRelaunch(options.targeted),
  ];
  const coldDiagnostics = options.source.cells
    .filter(
      (cell) =>
        cell.candidate === 'guest-simulator-framework-bridge' &&
        (cell.state === 'cold' || cell.state === 'cold-cold'),
    )
    .map(summarizeColdDiagnostic);
  const hierarchy = hierarchyEvidence(options.targeted);
  const hardGates = {
    warm: latencyGate(readiness, 'warm', 'p50 <300 ms and p95 <500 ms per screen', false),
    relaunch: relaunchGate(readiness, options.targeted),
    nonresidentBootstrap: bootstrapGate(options.targeted),
    boundedResources: resourceGate(options.targeted),
    liveRecovery: recoveryGate(options.targeted),
    hierarchy: hierarchy.gate,
    preferenceControl: preferenceGate(options.source),
  } as const;
  const failedGates = Object.entries(hardGates).filter(([, gate]) => gate.status === 'FAIL');
  return {
    schemaVersion: 'ios-simulator-ax-bridge-corrected.v3',
    interpretation: 'maintainer-corrected',
    generatedAt: new Date().toISOString(),
    revision: options.targeted.revision,
    sourceArtifact: {
      path: options.sourcePath,
      revision: options.source.revision,
      originalDecision: 'NO-GO',
      interpretation: 'superseded-stretch-only',
      hostClient: options.targeted.sourceArtifact.hostClient,
    },
    targetedArtifact: {
      path: options.targetedPath,
      revision: options.targeted.revision,
    },
    target: options.targeted.target,
    toolchain: options.targeted.toolchain,
    host: options.targeted.host,
    guestMechanism: options.targeted.guestMechanism,
    readiness,
    hardGates,
    coldDiagnostics,
    stretchFindings: [
      ...options.source.decisionReasons.map((reason) => `Original broad-run finding: ${reason}`),
      'Cold and cold-cold first-look measurements include Simulator, app, daemon, and runner readiness costs; they are diagnostics, not candidate-owned hard gates.',
      'The former warm 75/150 ms and relaunch 250 ms thresholds are stretch findings under the corrected contract.',
      `Nonresident bootstrap samples were taken on a host with 1-minute load average ${options.targeted.host.loadAverage1m} on ${options.targeted.host.cpuCores} cores; per-sample load is recorded with each sample.`,
    ],
    decision: failedGates.length === 0 ? 'GO' : 'NO-GO',
    decisionReasons: failedGates.map(
      ([name, gate]) => `${name} hard gate failed: ${gate.evidence}.`,
    ),
    liveRecovery: options.targeted.recovery,
    bootstrap: options.targeted.bootstrap,
    hierarchy: hierarchy.value,
    compatibilityRisk: {
      interface: 'private-idb-simulator-guest',
      assessment:
        'SimulatorFrameworkBridge and its accessibility wire protocol are private idb/Apple implementation details with no compatibility guarantee.',
      control:
        'Pin the official idb release and observed guest SHA-256, keep this route Simulator-only behind the acquisition adapter, and re-run this verifier for every idb, Xcode, or Simulator runtime change before production adoption.',
    },
    productionBoundary: 'no-production-routing-changes',
  };
}

export function writeCorrectedReport(outputPath: string, report: CorrectedReport): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, gzipSync(`${JSON.stringify(report)}\n`, { level: 9 }));
  fs.writeFileSync(markdownPath(outputPath), renderCorrectedMarkdown(report));
}

function markdownPath(outputPath: string): string {
  const replaced = outputPath.replace(/\.json(?:\.gz)?$/u, '.md');
  return replaced === outputPath ? `${outputPath}.md` : replaced;
}

function summarizeLatency(cell: SpikeCell): LatencySummary {
  const samples = cell.acquisitionSamples;
  const readable = samples.filter((sample) => sample.ok && sample.firstTree === 'readable');
  const observedGenerations = readable.flatMap((sample) =>
    observedGeneration(sample.acquisition?.targetGeneration),
  );
  return {
    state: cell.state as 'warm' | 'relaunch',
    screen: cell.screen,
    samples: samples.length,
    readableSamples: readable.length,
    readinessObservedSamples: observedGenerations.length,
    generationCount: new Set(observedGenerations).size,
    candidateP50Ms: optionalPercentile(
      readable.map((sample) => sample.wallClockMs),
      50,
    ),
    candidateP95Ms: optionalPercentile(
      readable.map((sample) => sample.wallClockMs),
      95,
    ),
    preparationP95Ms: optionalPercentile(
      readable.map((sample) => sample.preparationMs),
      95,
    ),
    firstLookP95Ms: optionalPercentile(
      readable.map((sample) => sample.firstLookMs),
      95,
    ),
  };
}

function summarizeColdDiagnostic(cell: SpikeCell): CorrectedReport['coldDiagnostics'][number] {
  const readable = cell.acquisitionSamples.filter(
    (sample) => sample.ok && sample.firstTree === 'readable',
  );
  return {
    state: cell.state as 'cold' | 'cold-cold',
    screen: cell.screen,
    preparationP95Ms: optionalPercentile(
      readable.map((sample) => sample.preparationMs),
      95,
    ),
    firstLookP95Ms: optionalPercentile(
      readable.map((sample) => sample.firstLookMs),
      95,
    ),
    interpretation: 'excluded-runner-and-app-readiness-costs',
  };
}

function summarizeTargetedRelaunch(targeted: TargetedRawArtifact): LatencySummary[] {
  return targeted.config.screens.map((screen) => {
    const samples = targeted.relaunch.filter((sample) => sample.screen === screen);
    const readable = samples.filter(
      (sample) =>
        sample.response.ok &&
        sample.response.acquisition !== undefined &&
        sample.response.acquisition.nodes.length > 0 &&
        sample.response.acquisition.targetGeneration === `pid:${sample.appPid}`,
    );
    const observedGenerations = readable.flatMap((sample) =>
      observedGeneration(sample.response.acquisition?.targetGeneration),
    );
    return {
      state: 'relaunch',
      screen,
      samples: samples.length,
      readableSamples: readable.length,
      readinessObservedSamples: readable.filter((sample) => sample.readinessAttempts > 0).length,
      generationCount: new Set(observedGenerations).size,
      candidateP50Ms: optionalPercentile(
        readable.map((sample) => sample.durationMs),
        50,
      ),
      candidateP95Ms: optionalPercentile(
        readable.map((sample) => sample.durationMs),
        95,
      ),
      preparationP95Ms: optionalPercentile(
        readable.map((sample) => sample.readinessMs),
        95,
      ),
      firstLookP95Ms: optionalPercentile(
        readable.map((sample) => sample.readinessMs + sample.durationMs),
        95,
      ),
    };
  });
}

function latencyGate(
  readiness: readonly LatencySummary[],
  state: 'warm' | 'relaunch',
  target: string,
  requireReadiness: boolean,
): GateResult {
  const cells = readiness.filter((summary) => summary.state === state);
  const passed = cells.filter((summary) => latencyPassed(summary, requireReadiness));
  return {
    status: cells.length > 0 && passed.length === cells.length ? 'PASS' : 'FAIL',
    target,
    evidence: `${passed.length}/${cells.length} ${state} screen cells passed; ${cells.map(formatLatency).join('; ') || 'no cells'}`,
  };
}

function relaunchGate(
  readiness: readonly LatencySummary[],
  targeted: TargetedRawArtifact,
): GateResult {
  const latency = latencyGate(
    readiness,
    'relaunch',
    'p95 <500 ms per representative screen with every read paired to its expected generation',
    true,
  );
  const complete = readiness
    .filter((summary) => summary.state === 'relaunch')
    .every((summary) => summary.samples === targeted.config.samples);
  const expectedSampleCount = targeted.config.screens.length * targeted.config.samples;
  const representativeScreens = new Set(targeted.relaunch.map((sample) => sample.screen));
  const corpusComplete =
    targeted.relaunch.length === expectedSampleCount &&
    targeted.config.screens.every((screen) => representativeScreens.has(screen));
  return {
    status: latency.status === 'PASS' && complete && corpusComplete ? 'PASS' : 'FAIL',
    target: 'p95 <500 ms per screen after independently observed new-generation readiness',
    evidence: `${latency.evidence}; ${targeted.relaunch.length}/${expectedSampleCount} Node-direct samples across ${representativeScreens.size}/${targeted.config.screens.length} screens`,
  };
}

function preferenceGate(source: SpikeReport): GateResult {
  const evidence = source.preferenceEvidence ?? missingPreferenceEvidence();
  const changes = evidence.diffs.flatMap((diff) => diff.changes);
  const required = ['AutomationEnabled', 'IgnoreAXServerEntitlements'];
  const applied = required.filter((key) => hasEnabledPreference(changes, key));
  const passed = [evidence.applied, evidence.restored, applied.length === required.length].every(
    Boolean,
  );
  return {
    status: gateStatus(passed),
    target: 'task-owned Simulator accessibility preferences applied preboot and restored',
    evidence: `applied=${String(evidence.applied)}; restored=${String(evidence.restored)}; enabled keys=${applied.join(', ')}; fixture launch compatible=${String(evidence.fixtureLaunchCompatible)}`,
  };
}

function missingPreferenceEvidence(): NonNullable<SpikeReport['preferenceEvidence']> {
  return {
    applied: false,
    restored: false,
    fixtureLaunchCompatible: null,
    simulatorStateBefore: 'unknown',
    diffs: [],
  };
}

function gateStatus(passed: boolean): GateResult['status'] {
  return passed ? 'PASS' : 'FAIL';
}

function hasEnabledPreference(
  changes: NonNullable<SpikeReport['preferenceEvidence']>['diffs'][number]['changes'],
  key: string,
): boolean {
  return changes.some((change) => change.key === key && change.after === true);
}

function bootstrapGate(targeted: TargetedRawArtifact): GateResult {
  const usable = targeted.bootstrap.filter((sample) => sample.usableTree);
  const p95 = optionalPercentile(
    targeted.bootstrap.map((sample) => sample.durationMs),
    95,
  );
  const passed = [
    targeted.bootstrap.length === 5,
    usable.length === targeted.bootstrap.length,
    p95 !== null,
    p95 !== null && p95 < 2_000,
  ].every(Boolean);
  return {
    status: passed ? 'PASS' : 'FAIL',
    target: 'nonresident companion + reader bootstrap and first usable tree p95 <2,000 ms',
    evidence: `${usable.length}/${targeted.bootstrap.length} usable trees; p95=${formatMs(p95)}; the timer covered guest spawn, socket connect, and the first tree after a throwaway probe observed the relaunched app's readiness (readiness p95=${formatMs(
      optionalPercentile(
        targeted.bootstrap.map((sample) => sample.readinessMs),
        95,
      ),
    )}), with no resident bridge, xcodebuild, XCTest, or agent-device runner in the timed path`,
  };
}

function recoveryGate(targeted: TargetedRawArtifact): GateResult {
  const passed = targeted.recovery.filter(
    (probe) =>
      recoveryOutcomeMatches(probe) &&
      probe.recoveredResponse.ok === true &&
      probe.recoveredResponse.acquisition?.nodes.length !== 0,
  );
  return {
    status: targeted.recovery.length === 4 && passed.length === 4 ? 'PASS' : 'FAIL',
    target: 'live crash, timeout, cancellation, and honest target-generation handling',
    evidence: `${passed.length}/${targeted.recovery.length} probes returned a typed failure or typed unavailable-generation residue and a usable recovered response`,
  };
}

function resourceGate(targeted: TargetedRawArtifact): GateResult {
  const responses = [
    ...targeted.bootstrap.map((sample) => sample.response),
    ...targeted.relaunch.map((sample) => sample.response),
    ...targeted.recovery.map((probe) => probe.recoveredResponse),
  ].filter((response) => response.ok);
  const measured = responses.filter(
    (response) => response.metrics.cpuMs !== null && response.metrics.memoryBytes !== null,
  );
  const withinBounds = measured.filter(
    (response) =>
      response.metrics.cpuMs! <= targeted.limits.maxCpuMs &&
      response.metrics.memoryBytes! <= targeted.limits.maxMemoryBytes,
  );
  const maxCpuMs = Math.max(0, ...measured.map((response) => response.metrics.cpuMs!));
  const maxMemoryBytes = Math.max(0, ...measured.map((response) => response.metrics.memoryBytes!));
  return {
    status: responses.length > 0 && withinBounds.length === responses.length ? 'PASS' : 'FAIL',
    target: `guest CPU <=${targeted.limits.maxCpuMs} ms and RSS <=${targeted.limits.maxMemoryBytes} bytes per successful read`,
    evidence: `${withinBounds.length}/${responses.length} successful reads measured within bounds; max CPU=${maxCpuMs.toFixed(1)} ms; max RSS=${String(maxMemoryBytes)} bytes`,
  };
}

function recoveryOutcomeMatches(probe: TargetedRawArtifact['recovery'][number]): boolean {
  const failure = probe.response.failure;
  if (failure) return failure.kind === probe.operation;
  if (probe.operation !== 'stale-generation') return false;
  return hasUnavailableGeneration(probe.response);
}

function hasUnavailableGeneration(
  response: TargetedRawArtifact['recovery'][number]['response'],
): boolean {
  const acquisition = response.acquisition;
  if (!acquisition) return false;
  return [
    response.ok,
    acquisition.targetGeneration === null,
    acquisition.residue.some(isUnavailableGeneration),
  ].every(Boolean);
}

function isUnavailableGeneration(
  residue: NonNullable<
    TargetedRawArtifact['bootstrap'][number]['response']['acquisition']
  >['residue'][number],
): boolean {
  return residue.kind === 'unavailable-fact' && residue.fact === 'generation';
}

/**
 * Hierarchy is a hard fact, not a presentation: the guest must either return structural depth with
 * an honest truncation flag, or type its absence as provider-pruned residue. A flat tree claiming
 * completeness fails.
 */
function hierarchyEvidence(targeted: TargetedRawArtifact): {
  gate: GateResult;
  value: CorrectedReport['hierarchy'];
} {
  const usable = targeted.bootstrap.filter((sample) => sample.usableTree);
  const depth = Math.max(0, ...usable.map((sample) => sample.response.metrics.maxTraversalDepth));
  const truncated = usable.some((sample) => sample.response.acquisition?.truncated === true);
  const typedFlat = usable.some((sample) =>
    (sample.response.acquisition?.residue ?? []).some(
      (residue) => residue.kind === 'provider-pruned' && residue.fields.includes('depth'),
    ),
  );
  if (usable.length > 0 && depth > 0) {
    return {
      gate: {
        status: 'PASS',
        target:
          'structural hierarchy acquired with typed truncation, or its absence typed as residue',
        evidence: `nested tree with traversal depth ${depth} in ${usable.length}/${targeted.bootstrap.length} samples; truncated=${truncated}`,
      },
      value: {
        observedTraversalDepth: depth,
        depthComplete: !truncated,
        interpretation: 'nested-tree',
      },
    };
  }
  return {
    gate: {
      status: typedFlat ? 'PASS' : 'FAIL',
      target:
        'structural hierarchy acquired with typed truncation, or its absence typed as residue',
      evidence: typedFlat
        ? 'flat response with typed provider-pruned/depth residue; depth is not treated as complete'
        : 'no hierarchy and no typed residue observed',
    },
    value: {
      observedTraversalDepth: 0,
      depthComplete: false,
      interpretation: usable.length === 0 ? 'not-observed' : 'flat-provider-response',
    },
  };
}

function formatLatency(summary: LatencySummary): string {
  return `${summary.screen} p50/p95=${formatMs(summary.candidateP50Ms)}/${formatMs(summary.candidateP95Ms)} ready=${summary.readinessObservedSamples}/${summary.samples}`;
}

function optionalPercentile(
  values: readonly (number | undefined)[],
  percentage: number,
): number | null {
  const finite = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (finite.length === 0) return null;
  return percentile(finite, percentage);
}

function observedGeneration(value: string | null | undefined): readonly string[] {
  return typeof value === 'string' ? [value] : [];
}

function latencyPassed(summary: LatencySummary, requireReadiness: boolean): boolean {
  return [
    summary.readableSamples === summary.samples,
    !requireReadiness || summary.readinessObservedSamples === summary.samples,
    summary.candidateP50Ms !== null,
    summary.candidateP50Ms !== null && summary.candidateP50Ms < 300,
    summary.candidateP95Ms !== null,
    summary.candidateP95Ms !== null && summary.candidateP95Ms < 500,
  ].every(Boolean);
}

function formatMs(value: number | null): string {
  return value === null ? '–' : `${value.toFixed(1)} ms`;
}

function percentile(values: readonly number[], percentage: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentage / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}
