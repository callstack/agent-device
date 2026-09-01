import { runFramedBatch } from './framed-process.ts';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import { failureResponse } from './protocol.ts';
import type { LifecycleEvidence, SpikeRequest, SpikeResponse } from './types.ts';

export async function runLifecycleProbes(): Promise<LifecycleEvidence> {
  const request = probeRequest('lifecycle');
  const limits = { ...DEFAULT_SPIKE_LIMITS, maxDurationMs: 1_000 };
  const crash = await runFailureProbe('crash', request, limits);
  const timeout = await runFailureProbe('hang', request, limits);
  const cancellation = await runCancellationProbe(request, limits);
  const staleResponse = failureResponse(request, {
    kind: 'stale-generation',
    code: 'target-generation-mismatch',
    expectedTargetGeneration: 'expected',
    observedTargetGeneration: 'observed',
  });
  const stale = await runFramedBatch(nodeScript('stale-generation', staleResponse), [request], {
    limits,
  });
  return {
    source: 'framed-protocol-fixture',
    crash: { failure: crash.failure, recovered: crash.recovered },
    timeout: { failure: timeout.failure, recovered: timeout.recovered },
    cancellation: { failure: cancellation.failure, recovered: cancellation.recovered },
    staleGeneration: {
      failure: stale.responses[0]?.failure?.kind ?? 'transport-failure',
      recovered: await runHealthyProbe(request, limits),
    },
  };
}

function probeRequest(id: string): SpikeRequest {
  return {
    version: 1,
    id,
    candidate: 'public-macos-ax',
    simulatorUdid: '00000000-0000-0000-0000-000000000000',
    state: 'warm',
    screen: 'quiet',
    appBundleId: 'com.apple.dt.Devices',
    limits: DEFAULT_SPIKE_LIMITS,
  };
}

async function runFailureProbe(
  script: string,
  request: SpikeRequest,
  limits: typeof DEFAULT_SPIKE_LIMITS,
): Promise<{ failure: NonNullable<SpikeResponse['failure']>['kind']; recovered: boolean }> {
  const failed = await runFramedBatch(nodeScript(script), [request], { limits });
  const failure = failed.responses[0]?.failure?.kind ?? 'transport-failure';
  const recovered = await runHealthyProbe(request, limits);
  return { failure, recovered };
}

async function runCancellationProbe(
  request: SpikeRequest,
  limits: typeof DEFAULT_SPIKE_LIMITS,
): Promise<{ failure: NonNullable<SpikeResponse['failure']>['kind']; recovered: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15);
  const result = await runFramedBatch(nodeScript('hang'), [request], {
    signal: controller.signal,
    limits,
  });
  clearTimeout(timer);
  return {
    failure: result.responses[0]?.failure?.kind ?? 'transport-failure',
    recovered: (await runHealthyProbe(request, limits)) === true,
  };
}

async function runHealthyProbe(
  request: SpikeRequest,
  limits: typeof DEFAULT_SPIKE_LIMITS,
): Promise<boolean> {
  const result = await runFramedBatch(nodeScript('healthy'), [request], { limits });
  return result.responses[0]?.ok === true;
}

function nodeScript(
  mode: string,
  overrideResponse?: SpikeResponse,
): { file: string; args: string[] } {
  const response = JSON.stringify(
    overrideResponse ?? {
      version: 1,
      ok: true,
      acquisition: {
        targetId: 'simulator:probe',
        targetGeneration: 'generation',
        nodes: [{ id: 'n0', role: 'AXApplication' }],
        viewport: { kind: 'missing', reason: 'not-provided' },
        truncated: false,
        residue: [],
      },
      metrics: {
        requestBytes: 1,
        responseBytes: 1,
        nodeCount: 1,
        maxTraversalDepth: 0,
        cpuMs: 0,
        memoryBytes: 1,
        durationMs: 1,
      },
    },
  );
  const modeStatement =
    mode === 'crash' ? 'process.exit(17);' : mode === 'hang' ? 'setInterval(() => {}, 1000);' : '';
  const script = `
    import process from 'node:process';
    ${modeStatement}
    if (${JSON.stringify(mode)} !== 'crash' && ${JSON.stringify(mode)} !== 'hang') {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      for (const line of input.split('\\n').filter(Boolean)) {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ ...${response}, id: request.id, candidate: request.candidate }) + '\\n');
      }
    });
    }
  `;
  return { file: process.execPath, args: ['--input-type=module', '-e', script] };
}
