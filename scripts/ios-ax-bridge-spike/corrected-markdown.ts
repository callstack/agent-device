import type { CorrectedReport, GateResult, LatencySummary } from './corrected-types.ts';

export function renderCorrectedMarkdown(report: CorrectedReport): string {
  const lines = [
    '# iOS Simulator AX bridge corrected evidence',
    '',
    `- Decision: **${report.decision}**`,
    '- Interpretation: **maintainer-corrected**',
    `- Revision: ${report.revision.commit} (${report.revision.branch})`,
    `- Target: ${report.target.name} (${report.target.udid}, ${report.target.runtime})`,
    `- Generated: ${report.generatedAt}`,
    `- Immutable broad raw artifact: \`${report.sourceArtifact.path}\` (original ${report.sourceArtifact.originalDecision}; interpretation superseded to stretch-only; host client ${report.sourceArtifact.hostClient})`,
    `- Narrow targeted raw artifact: \`${report.targetedArtifact.path}\` (host client ${report.guestMechanism.client})`,
    `- Host at generation: load average ${report.host.loadAverage1m} on ${report.host.cpuCores} cores`,
    '',
    'The broad raw corpus is preserved unchanged. Its old NO-GO used readiness-inclusive first-look and stretch thresholds; this report evaluates the corrected hard contract. The broad warm cells remain conservative upper bounds around the same in-Simulator reader. Relaunch uses the new Node-direct corpus below and does not rely on the legacy relaunch samples.',
    '',
    '## Evaluated guest mechanism',
    '',
    `- Guest reader: ${report.guestMechanism.implementation} ${report.guestMechanism.release} \`${report.guestMechanism.guestBinary}\` (observed SHA-256 \`${report.guestMechanism.guestBinarySha256}\`; required SHA-256 \`${report.guestMechanism.guestBinaryExpectedSha256 ?? 'not recorded'}\`) from \`${report.guestMechanism.companionArchive}\` (SHA-256 \`${report.guestMechanism.companionSha256}\`).`,
    `- Transport: ${report.guestMechanism.transport}.`,
    `- Traversal: ${report.guestMechanism.traversal}.`,
    '',
    '## Hard gates',
    '',
    '| Gate | Status | Target | Evidence |',
    '|---|---|---|---|',
    ...Object.entries(report.hardGates).map(([name, gate]) => gateLine(name, gate)),
    '',
    '## Readiness boundary and candidate-owned latency',
    '',
    'Warm and relaunch timing starts at bridge acquisition after fixture/app readiness admission. Every relaunch row comes from the Node-direct route and is paired with a separate probe that observed the exact relaunched process generation and expected screen anchor. The old first-look value includes Simulator, app, daemon, and runner costs.',
    '',
    '| State | Screen | Samples | Readable | Ready generation | Candidate p50/p95 ms | Readiness p95 ms | Old first-look p95 ms | Generations |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...report.readiness.map(readinessLine),
    '',
    '## Cold diagnostics',
    '',
    'Cold and cold-cold first-look measurements remain visible for diagnosis, but are excluded from the candidate-owned hard verdict because they combine environment and readiness boundaries with bridge work.',
    '',
    '| State | Screen | Preparation p95 ms | First-look p95 ms | Interpretation |',
    '|---|---|---:|---:|---|',
    ...report.coldDiagnostics.map(coldDiagnosticLine),
    '',
    '## Nonresident bootstrap',
    '',
    `- ${report.hardGates.nonresidentBootstrap.evidence}.`,
    `- ${report.hardGates.boundedResources.evidence}.`,
    '- The timed boundary begins with no resident bridge and ends at the first usable guest tree. Before each timer the fixture app was relaunched and a throwaway probe bridge polled until the new generation answered with a tree (readiness), then exited.',
    '',
    '| Sample | Duration ms | CPU ms | RSS MiB | Usable tree | Nodes | Depth | Generation | Readiness ms | Attempts | Host load |',
    '|---:|---:|---:|---:|---|---:|---:|---|---:|---:|---:|',
    ...report.bootstrap.map(bootstrapLine),
    '',
    '## Live candidate recovery',
    '',
    `- ${report.hardGates.liveRecovery.evidence}.`,
    '',
    '| Operation | Observed failure | Recovery response | Recovered tree |',
    '|---|---|---|---|',
    ...report.liveRecovery.map(recoveryLine),
    '',
    '## Hierarchy',
    '',
    `- ${report.hardGates.hierarchy.evidence}.`,
    `- Observed traversal depth: ${report.hierarchy.observedTraversalDepth}; depth complete: **${report.hierarchy.depthComplete}**; interpretation: ${report.hierarchy.interpretation}.`,
    '',
    '## Simulator preference control',
    '',
    `- ${report.hardGates.preferenceControl.evidence}.`,
    '- The broad capture applied its accessibility preference changes only to the disposable benchmark Simulator before boot, verified fixture launch compatibility, and restored the prior preference files and Simulator state afterward.',
    '',
    '## Private-interface compatibility risk',
    '',
    `- ${report.compatibilityRisk.assessment}`,
    `- Control: ${report.compatibilityRisk.control}`,
    '',
    '## Stretch findings',
    '',
    ...report.stretchFindings.map((finding) => `- ${finding}`),
    '',
    '## Production boundary',
    '',
    '- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.',
    '- The corrected result is evidence for the #2192 decision boundary only; it does not start production routing.',
  ];
  return `${lines.join('\n')}\n`;
}

function gateLine(name: string, gate: GateResult): string {
  return `| ${name} | **${gate.status}** | ${gate.target} | ${gate.evidence} |`;
}

function readinessLine(summary: LatencySummary): string {
  return `| ${summary.state} | ${summary.screen} | ${summary.samples} | ${summary.readableSamples} | ${summary.readinessObservedSamples} | ${formatMs(summary.candidateP50Ms)}/${formatMs(summary.candidateP95Ms)} | ${formatMs(summary.preparationP95Ms)} | ${formatMs(summary.firstLookP95Ms)} | ${summary.generationCount} |`;
}

function coldDiagnosticLine(diagnostic: CorrectedReport['coldDiagnostics'][number]): string {
  return `| ${diagnostic.state} | ${diagnostic.screen} | ${formatMs(diagnostic.preparationP95Ms)} | ${formatMs(diagnostic.firstLookP95Ms)} | excluded runner/app readiness costs |`;
}

function bootstrapLine(sample: CorrectedReport['bootstrap'][number]): string {
  const response = sample.response;
  return `| ${sample.index} | ${sample.durationMs.toFixed(1)} | ${formatMs(response.metrics.cpuMs)} | ${formatMib(response.metrics.memoryBytes)} | ${sample.usableTree} | ${response.metrics.nodeCount} | ${response.metrics.maxTraversalDepth} | ${response.acquisition?.targetGeneration ?? '–'} | ${sample.readinessMs.toFixed(0)} | ${sample.readinessAttempts} | ${sample.host.loadAverage1m} |`;
}

function recoveryLine(probe: CorrectedReport['liveRecovery'][number]): string {
  const recovery = probe.recoveredResponse;
  const status = recovery.ok ? 'ok' : 'failed';
  const nodes = recovery.acquisition?.nodes.length ?? 0;
  return `| ${probe.operation} | ${failureText(probe.response.failure)} | ${status} | ${nodes} nodes |`;
}

function failureText(failure: CorrectedReport['bootstrap'][number]['response']['failure']): string {
  if (!failure) return 'none/none';
  return `${failure.kind}/${failure.code ?? 'none'}`;
}

function formatMs(value: number | null): string {
  return value === null ? '–' : value.toFixed(1);
}

function formatMib(value: number | null): string {
  return value === null ? '–' : (value / 1024 / 1024).toFixed(1);
}
