import { firstTreeStatus } from './protocol.ts';
import { presentAcquisitionForMeasurement } from './presentation.ts';
import { screenFixture } from '../ios-snapshot-benchmark/definitions.ts';
import type { SpikeConfig } from './config.ts';
import type { SpikeCell, SpikeRequest, SpikeResponse, SpikeSample } from './types.ts';

export type CapturedResponse = Readonly<{
  response: SpikeResponse;
  stderr: string;
  startedAt: string;
  wallClockMs: number;
}>;

export function appendSamples(
  candidate: SpikeCell['candidate'],
  state: SpikeCell['state'],
  screen: SpikeCell['screen'],
  index: number,
  captured: CapturedResponse,
  preparationMs: number,
  acquisitionSamples: SpikeSample[],
  presentationSamples: SpikeSample[],
): void {
  const acquiredAt = new Date().toISOString();
  const status = fixtureBoundStatus(captured.response, screen);
  const keepRawExemplar =
    captured.response.acquisition !== undefined &&
    acquisitionSamples.every((sample) => sample.acquisition === undefined);
  acquisitionSamples.push({
    index: index + 1,
    candidate,
    state,
    screen,
    startedAt: captured.startedAt,
    finishedAt: acquiredAt,
    operation: 'acquisition',
    wallClockMs: captured.wallClockMs,
    preparationMs,
    firstLookMs: preparationMs + captured.wallClockMs,
    firstTree: status,
    ok: captured.response.ok,
    ...(keepRawExemplar ? { acquisition: captured.response.acquisition } : {}),
    metrics: captured.response.metrics,
    ...(captured.stderr ? { stderr: captured.stderr } : {}),
    ...(captured.response.failure ? { failure: captured.response.failure } : {}),
  });
  presentationSamples.push(presentationSample(candidate, state, screen, index, captured, status));
}

function fixtureBoundStatus(
  response: SpikeResponse,
  screen: SpikeCell['screen'],
): SpikeSample['firstTree'] {
  const status = firstTreeStatus(response);
  if (status !== 'readable' || !response.acquisition) return status;
  const fixture = screenFixture(screen);
  const anchor = fixture.postSetupAnchorText ?? fixture.anchorText;
  return response.acquisition.nodes.some((node) =>
    [node.label, node.value, node.identifier].some((value) => value?.includes(anchor)),
  )
    ? 'readable'
    : 'unreadable';
}

export function makeRequest(
  config: SpikeConfig,
  candidate: SpikeCell['candidate'],
  state: SpikeCell['state'],
  screen: SpikeCell['screen'],
  index: number,
  appPid?: number,
): SpikeRequest {
  return {
    version: 1,
    id: `${candidate}:${state}:${screen}:${index + 1}`,
    candidate,
    simulatorUdid: config.udid,
    state,
    screen,
    appBundleId: config.appBundleId,
    ...(config.targetWindowName === undefined ? {} : { targetWindowName: config.targetWindowName }),
    ...(config.targetProcessId === undefined ? {} : { targetProcessId: config.targetProcessId }),
    ...(candidate === 'guest-simulator-framework-bridge' && appPid !== undefined
      ? { expectedTargetGeneration: `pid:${appPid}` }
      : {}),
    limits: config.limits,
  };
}

function presentationSample(
  candidate: SpikeCell['candidate'],
  state: SpikeCell['state'],
  screen: SpikeCell['screen'],
  index: number,
  captured: CapturedResponse,
  status: SpikeSample['firstTree'],
): SpikeSample {
  if (!captured.response.acquisition)
    return failedPresentationSample(candidate, state, screen, index, captured, status);
  return successfulPresentationSample(candidate, state, screen, index, captured, status);
}

function failedPresentationSample(
  candidate: SpikeCell['candidate'],
  state: SpikeCell['state'],
  screen: SpikeCell['screen'],
  index: number,
  captured: CapturedResponse,
  status: SpikeSample['firstTree'],
): SpikeSample {
  const startedAt = new Date().toISOString();
  return {
    index: index + 1,
    candidate,
    state,
    screen,
    startedAt,
    finishedAt: new Date().toISOString(),
    operation: 'presentation',
    wallClockMs: 0,
    firstTree: status,
    ok: false,
    ...(captured.stderr ? { stderr: captured.stderr } : {}),
    presentation: {
      ok: false,
      payloadBytes: 0,
      nodeCount: 0,
      durationMs: 0,
      cpuMs: null,
      memoryBytes: process.memoryUsage().rss,
    },
    ...(captured.response.failure ? { failure: captured.response.failure } : {}),
  };
}

function successfulPresentationSample(
  candidate: SpikeCell['candidate'],
  state: SpikeCell['state'],
  screen: SpikeCell['screen'],
  index: number,
  captured: CapturedResponse,
  status: SpikeSample['firstTree'],
): SpikeSample {
  const startedAt = new Date().toISOString();
  const presented = presentAcquisitionForMeasurement(captured.response.acquisition!);
  return {
    index: index + 1,
    candidate,
    state,
    screen,
    startedAt,
    finishedAt: new Date().toISOString(),
    operation: 'presentation',
    wallClockMs: presented.measurement.durationMs,
    firstTree: status,
    ok: true,
    ...(captured.stderr ? { stderr: captured.stderr } : {}),
    presentation: presented.measurement,
  };
}
