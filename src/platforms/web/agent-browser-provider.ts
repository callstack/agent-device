import { runCmd } from '../../utils/exec.ts';
import { AppError } from '../../kernel/errors.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import { normalizeAudioProbeRecord } from '../../audio-probe-result.ts';
import { normalizeAgentBrowserNetworkRequests } from './agent-browser-network.ts';
import { normalizeAgentBrowserSnapshot } from './agent-browser-snapshot.ts';
import {
  isJsonObject,
  readNumberProperty,
  readStringProperty,
  type JsonObject,
} from './json-utils.ts';
import type {
  WebAudioProbeOptions,
  WebAudioProbeResult,
  WebProvider,
  WebSnapshotOptions,
  WebSnapshotResult,
} from './provider.ts';
import { mapManagedAgentBrowserError, resolveAgentBrowserTool } from './agent-browser-tool.ts';

const AGENT_BROWSER = 'agent-browser';
const AGENT_BROWSER_TIMEOUT_MS = 30_000;
const AGENT_BROWSER_DOCTOR_HINT =
  'Run `agent-device web setup` to install the managed web backend.';

type AgentBrowserProviderOptions = {
  session?: string;
  stateDir?: string;
};

export function createAgentBrowserWebProvider(
  options: AgentBrowserProviderOptions = {},
): WebProvider {
  const session = options.session?.trim();
  const runJson = async (args: string[]): Promise<unknown> =>
    await runAgentBrowserJson(args, { session, options });

  return {
    async open(target) {
      await runJson(['open', target]);
    },
    async close() {
      await runJson(['close']);
    },
    async startRecording(outPath) {
      await runJson(['record', 'start', outPath]);
    },
    async stopRecording() {
      await runJson(['record', 'stop']);
    },
    async snapshot(snapshotOptions) {
      return await captureAgentBrowserSnapshot(runJson, snapshotOptions);
    },
    async screenshot(outPath, screenshotOptions) {
      await runJson(['screenshot', ...(screenshotOptions?.fullscreen ? ['--full'] : []), outPath]);
    },
    async setViewport(width, height) {
      await runJson(['set', 'viewport', String(width), String(height)]);
    },
    async click(x, y) {
      await clickCoordinates(runJson, x, y);
    },
    async clickRef(ref) {
      await runJson(['click', browserRefSelector(ref)]);
    },
    async fill(x, y, text) {
      // The shared web interactor is coordinate-first; bridge that to low-level
      // browser input until a future ref-targeted web path can call native fill.
      await clickCoordinates(runJson, x, y);
      await runJson(['press', selectAllShortcut()]);
      await runJson(['keyboard', 'type', text]);
    },
    async fillRef(ref, text) {
      await runJson(['fill', browserRefSelector(ref), text]);
    },
    async typeText(text) {
      await runJson(['keyboard', 'type', text]);
    },
    async scroll(direction, scrollOptions) {
      await runPacedScroll(runJson, direction, scrollOptions);
      return scrollOptions?.durationMs !== undefined
        ? { durationMs: scrollOptions.durationMs }
        : {};
    },
    async dumpNetwork(options) {
      return normalizeAgentBrowserNetworkRequests(await runJson(['network', 'requests']), options);
    },
    async probeAudio(options) {
      return normalizeAgentBrowserAudioProbeResult(
        await runJson(['eval', buildAudioProbeEvalScript(options)]),
      );
    },
  };
}

function buildAudioProbeEvalScript(options: WebAudioProbeOptions): string {
  return `(${audioProbeEvalScript.toString()})(${JSON.stringify({
    action: options.action,
    durationMs: options.durationMs,
    bucketMs: options.bucketMs,
    source: options.source ?? 'media-elements',
  })})`;
}

type AudioProbePageRecord = Record<string, any>;

declare const window: AudioProbePageRecord;
declare const document: { querySelectorAll(selector: string): any[] };

function audioProbeEvalScript(options: AudioProbePageRecord): unknown {
  const key = '__agentDeviceAudioProbe';
  const contextKey = '__agentDeviceAudioProbeContext';
  const sourceKey = '__agentDeviceAudioProbeSources';
  const silenceDb = -90;
  const now = () => Date.now();
  const dbfs = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return silenceDb;
    return Math.max(silenceDb, Math.min(0, Math.round(20 * Math.log10(value))));
  };
  const note = (probe: AudioProbePageRecord, message: string) => {
    if (!probe.notes.includes(message)) probe.notes.push(message);
  };
  const scopeNote =
    'Audio probe samples HTML media elements exposed to Web Audio; it is not whole-tab or system audio capture.';
  const routingNote =
    'URL-backed media elements may be routed through the probe AudioContext while they are observed.';
  const mediaElements = () => Array.from(document.querySelectorAll('audio,video'));
  const stopProbe = (probe: AudioProbePageRecord | undefined, reason: string) => {
    if (!probe || probe.state === 'stopped') return probe;
    clearInterval(probe.timer);
    clearTimeout(probe.timeout);
    probe.timer = undefined;
    probe.timeout = undefined;
    probe.state = 'stopped';
    probe.active = false;
    probe.reason = reason;
    probe.stoppedAt = now();
    for (const entry of probe.analysers) {
      try {
        entry.analyser.disconnect();
        entry.source.disconnect();
        if (entry.audible) entry.source.connect(probe.context.destination);
      } catch {}
    }
    if (probe.resumeOnGesture) {
      for (const eventName of ['click', 'pointerdown', 'keydown']) {
        window.removeEventListener(eventName, probe.resumeOnGesture, true);
      }
      probe.resumeOnGesture = undefined;
    }
    return probe;
  };
  const getContext = () => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return undefined;
    const existing = window[contextKey];
    if (existing && existing.state !== 'closed') return existing;
    const context = new AudioContextCtor();
    window[contextKey] = context;
    return context;
  };
  const createElementAudioSource = (probe: AudioProbePageRecord, element: AudioProbePageRecord) => {
    if (!element.currentSrc && !element.src && element.readyState === 0) return undefined;
    try {
      if (!window[sourceKey]) window[sourceKey] = new WeakMap();
      let source = window[sourceKey].get(element);
      if (!source) {
        // createMediaElementSource permanently moves this element through the
        // shared probe AudioContext. We keep that context open and reconnect the
        // source to destination on stop so audible playback survives the probe.
        source = probe.context.createMediaElementSource(element);
        window[sourceKey].set(element, source);
      }
      source.disconnect();
      return { source, audible: true };
    } catch {
      return undefined;
    }
  };
  const createMediaStreamAudioSource = (
    probe: AudioProbePageRecord,
    stream: AudioProbePageRecord | undefined,
  ) => {
    if (!stream || typeof stream.getAudioTracks !== 'function') return undefined;
    if (stream.getAudioTracks().length === 0) return undefined;
    return { source: probe.context.createMediaStreamSource(stream), audible: false };
  };
  const createCaptureStreamAudioSource = (
    probe: AudioProbePageRecord,
    element: AudioProbePageRecord,
  ) => {
    if (typeof element.captureStream !== 'function') return undefined;
    const stream = element.captureStream();
    return createMediaStreamAudioSource(probe, stream);
  };
  const discover = (probe: AudioProbePageRecord) => {
    const elements = mediaElements();
    probe.mediaElementCount = elements.length;
    for (const element of elements) {
      if (probe.seen.has(element)) continue;
      const sourceEntry =
        createMediaStreamAudioSource(probe, element.srcObject) ??
        createCaptureStreamAudioSource(probe, element) ??
        createElementAudioSource(probe, element);
      if (!sourceEntry) {
        note(probe, 'Some media elements do not expose capturable audio to Web Audio.');
        continue;
      }
      probe.seen.add(element);
      const analyser = probe.context.createAnalyser();
      analyser.fftSize = 2048;
      sourceEntry.source.connect(analyser);
      analyser.connect(sourceEntry.audible ? probe.context.destination : probe.sink);
      probe.analysers.push({
        ...sourceEntry,
        analyser,
        buffer: new Float32Array(analyser.fftSize),
      });
    }
    probe.sourceCount = probe.analysers.length;
    if (probe.sourceCount === 0) {
      note(probe, 'No capturable page media audio sources were found yet.');
    }
  };
  const sample = (probe: AudioProbePageRecord | undefined) => {
    if (!probe || probe.state !== 'running') return;
    discover(probe);
    let totalSquares = 0;
    let totalSamples = 0;
    let peak = 0;
    for (const entry of probe.analysers) {
      entry.analyser.getFloatTimeDomainData(entry.buffer);
      for (const value of entry.buffer) {
        totalSquares += value * value;
        totalSamples += 1;
        const abs = Math.abs(value);
        if (abs > peak) peak = abs;
      }
    }
    const rms = totalSamples > 0 ? Math.sqrt(totalSquares / totalSamples) : 0;
    const rmsDb = dbfs(rms);
    const peakDb = dbfs(peak);
    probe.rmsDbfs.push(rmsDb);
    probe.peakDbfs.push(peakDb);
    probe.heard = probe.heard || rmsDb > silenceDb || peakDb > silenceDb;
    const maxSamples = Math.ceil(probe.durationMs / probe.bucketMs) + 2;
    if (probe.rmsDbfs.length > maxSamples)
      probe.rmsDbfs.splice(0, probe.rmsDbfs.length - maxSamples);
    if (probe.peakDbfs.length > maxSamples)
      probe.peakDbfs.splice(0, probe.peakDbfs.length - maxSamples);
    if (now() - probe.startedAt >= probe.durationMs) stopProbe(probe, 'duration');
  };
  const result = (probe: AudioProbePageRecord | undefined) => {
    const mediaCount = mediaElements().length;
    if (!probe) return stoppedResult([scopeNote, routingNote]);
    return {
      audio: 'probe',
      state: probe.state,
      active: probe.state === 'running',
      heard: probe.heard,
      source: 'media-elements',
      backend: 'agent-browser',
      durationMs: probe.durationMs,
      elapsedMs: Math.max(
        0,
        Math.min((probe.stoppedAt || now()) - probe.startedAt, probe.durationMs),
      ),
      bucketMs: probe.bucketMs,
      sampleCount: probe.rmsDbfs.length,
      mediaElementCount: mediaCount,
      sourceCount: probe.sourceCount,
      rmsDbfs: probe.rmsDbfs.slice(),
      peakDbfs: probe.peakDbfs.slice(),
      startedAt: new Date(probe.startedAt).toISOString(),
      stoppedAt: probe.stoppedAt ? new Date(probe.stoppedAt).toISOString() : undefined,
      reason: probe.reason,
      notes: [scopeNote, routingNote, ...probe.notes],
    };
  };
  const stoppedResult = (notes: string[]) => ({
    audio: 'probe',
    state: 'stopped',
    active: false,
    heard: false,
    source: 'media-elements',
    backend: 'agent-browser',
    durationMs: Number(options.durationMs) || 10000,
    elapsedMs: 0,
    bucketMs: Number(options.bucketMs) || 1000,
    sampleCount: 0,
    mediaElementCount: mediaElements().length,
    sourceCount: 0,
    rmsDbfs: [],
    peakDbfs: [],
    notes,
  });
  const action = options.action || 'status';
  let probe = window[key];
  if (probe && probe.state === 'running' && now() - probe.startedAt >= probe.durationMs) {
    sample(probe);
    stopProbe(probe, 'duration');
  }
  if (action === 'start') {
    if (probe) stopProbe(probe, 'restarted');
    const context = getContext();
    if (!context) {
      return stoppedResult(['Web Audio API is not available in this browser context.']);
    }
    const sink = context.createGain();
    sink.gain.value = 0;
    sink.connect(context.destination);
    probe = {
      state: 'running',
      active: true,
      context,
      sink,
      seen: new WeakSet(),
      analysers: [],
      mediaElementCount: 0,
      sourceCount: 0,
      durationMs: Math.max(100, Number(options.durationMs) || 10000),
      bucketMs: Math.max(100, Number(options.bucketMs) || 1000),
      startedAt: now(),
      stoppedAt: undefined,
      reason: undefined,
      heard: false,
      rmsDbfs: [],
      peakDbfs: [],
      notes: [],
    };
    window[key] = probe;
    try {
      void context.resume();
    } catch {
      note(probe, 'AudioContext could not be resumed by the probe.');
    }
    probe.resumeOnGesture = () => {
      try {
        void context.resume();
      } catch {
        note(probe, 'AudioContext could not be resumed from a user gesture.');
      }
    };
    for (const eventName of ['click', 'pointerdown', 'keydown']) {
      window.addEventListener(eventName, probe.resumeOnGesture, {
        capture: true,
        once: true,
      });
    }
    discover(probe);
    probe.timer = setInterval(() => sample(probe), probe.bucketMs);
    probe.timeout = setTimeout(() => stopProbe(probe, 'duration'), probe.durationMs);
    return result(probe);
  }
  if (action === 'stop') {
    if (probe) sample(probe);
    stopProbe(probe, 'manual');
    return result(probe);
  }
  if (probe) sample(probe);
  return result(probe);
}

function normalizeAgentBrowserAudioProbeResult(data: unknown): WebAudioProbeResult {
  const record = readAgentBrowserEvalResultRecord(data);
  return normalizeAudioProbeRecord(record, {
    source: 'media-elements',
    backend: 'agent-browser',
    durationMs: 0,
    elapsedMs: 0,
    bucketMs: 1000,
    activeFallback: false,
    mediaElementCount: 0,
    sourceCount: 0,
  }) as WebAudioProbeResult;
}

function readAgentBrowserEvalResultRecord(data: unknown): JsonObject {
  if (!isJsonObject(data)) return {};
  return isJsonObject(data.result) ? data.result : data;
}

async function runPacedScroll(
  runJson: (args: string[]) => Promise<unknown>,
  direction: string,
  scrollOptions: { amount?: number; pixels?: number; durationMs?: number } | undefined,
): Promise<void> {
  const steps = buildPacedScrollSteps(scrollOptions);
  for (const step of steps) {
    await runJson(buildScrollArgs(direction, step.distance));
    if (step.delayAfterMs > 0) await sleep(step.delayAfterMs);
  }
}

type ScrollStep = {
  distance?: number;
  delayAfterMs: number;
};

function buildPacedScrollSteps(
  scrollOptions: { amount?: number; pixels?: number; durationMs?: number } | undefined,
): ScrollStep[] {
  const requestedDistance = scrollOptions?.pixels ?? scrollOptions?.amount;
  const durationMs = scrollOptions?.durationMs;
  if (durationMs === undefined || durationMs <= 0) {
    return [{ distance: requestedDistance, delayAfterMs: 0 }];
  }

  const stepCount = Math.max(1, Math.min(20, Math.ceil(durationMs / 50)));
  const intervalMs = durationMs / Math.max(1, stepCount - 1);
  return scrollStepDistances(scrollOptions, stepCount).map((distance, index) => ({
    distance,
    delayAfterMs: index < stepCount - 1 ? intervalMs : 0,
  }));
}

function scrollStepDistances(
  scrollOptions: { amount?: number; pixels?: number } | undefined,
  stepCount: number,
): number[] {
  const totalDistance = scrollOptions?.pixels ?? scrollOptions?.amount ?? 300;
  if (scrollOptions?.amount !== undefined && scrollOptions.pixels === undefined) {
    return Array.from({ length: stepCount }, () => totalDistance / stepCount);
  }
  return distributeIntegerDistance(Math.round(totalDistance), stepCount);
}

function distributeIntegerDistance(totalDistance: number, stepCount: number): number[] {
  const baseDistance = Math.floor(totalDistance / stepCount);
  const remainder = totalDistance - baseDistance * stepCount;
  return Array.from({ length: stepCount }, (_, index) =>
    index < remainder ? baseDistance + 1 : baseDistance,
  );
}

function buildScrollArgs(direction: string, distance: number | undefined): string[] {
  return ['scroll', direction, ...(distance === undefined ? [] : [String(distance)])];
}

async function clickCoordinates(
  runJson: (args: string[]) => Promise<unknown>,
  x: number,
  y: number,
): Promise<void> {
  await runJson(['mouse', 'move', String(Math.round(x)), String(Math.round(y))]);
  await runJson(['mouse', 'down']);
  await runJson(['mouse', 'up']);
}

async function captureAgentBrowserSnapshot(
  runJson: (args: string[]) => Promise<unknown>,
  options: WebSnapshotOptions | undefined,
): Promise<WebSnapshotResult> {
  const data = await runJson(buildSnapshotArgs(options));
  return await normalizeAgentBrowserSnapshot(
    data,
    options?.includeRects ? async (ref) => await fetchRefRect(runJson, ref) : undefined,
  );
}

function buildSnapshotArgs(options: WebSnapshotOptions | undefined): string[] {
  return [
    'snapshot',
    ...(options?.interactiveOnly ? ['--interactive'] : []),
    ...(options?.raw ? [] : ['--compact']),
    ...(typeof options?.depth === 'number' ? ['--depth', String(options.depth)] : []),
    ...(options?.scope ? ['--selector', options.scope] : []),
  ];
}

async function fetchRefRect(
  runJson: (args: string[]) => Promise<unknown>,
  ref: string,
): Promise<Rect | undefined> {
  try {
    return parseRect(await runJson(['get', 'box', browserRefSelector(ref)]));
  } catch (error) {
    if (isIgnorableBoxError(error)) return undefined;
    throw error;
  }
}

function isIgnorableBoxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/\bstale\b/i.test(message) && /\bbox\b|not visible|not found|no element/i.test(message);
}

async function runAgentBrowserJson(
  args: string[],
  params: { session: string | undefined; options: AgentBrowserProviderOptions },
): Promise<unknown> {
  const { session, options } = params;
  const cliArgs = [...args, '--json', ...(session ? ['--session', session] : [])];
  const result = await runAgentBrowserCommand(cliArgs, options);
  const parsed = parseAgentBrowserJson(result.stdout, result.stderr, cliArgs, result.exitCode);
  return unwrapAgentBrowserJson(parsed, result, cliArgs);
}

async function runAgentBrowserCommand(
  cliArgs: string[],
  options: AgentBrowserProviderOptions,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const tool = await resolveAgentBrowserTool({ stateDir: options.stateDir });
    const result = await runCmd(tool.command, cliArgs, {
      allowFailure: true,
      env: tool.env,
      timeoutMs: AGENT_BROWSER_TIMEOUT_MS,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
  } catch (error) {
    throw mapAgentBrowserRunError(error, cliArgs);
  }

  return { stdout, stderr, exitCode };
}

function unwrapAgentBrowserJson(
  parsed: unknown,
  result: { stdout: string; stderr: string; exitCode: number },
  cliArgs: string[],
): unknown {
  if (!isJsonObject(parsed)) return parsed;

  const success = parsed.success ?? parsed.ok;
  if (success === false) {
    throw new AppError(toErrorCode(parsed.code), readEnvelopeErrorMessage(parsed), {
      cmd: AGENT_BROWSER,
      args: cliArgs,
      hint: readStringProperty(parsed, 'hint') ?? AGENT_BROWSER_DOCTOR_HINT,
      agentBrowserError: parsed.error,
    });
  }
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'agent-browser command failed', {
      cmd: AGENT_BROWSER,
      args: cliArgs,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 500),
      stderr: result.stderr.slice(0, 500),
      hint: readStringProperty(parsed, 'hint') ?? AGENT_BROWSER_DOCTOR_HINT,
    });
  }

  return Object.hasOwn(parsed, 'data') ? parsed.data : parsed;
}

function parseAgentBrowserJson(
  stdout: string,
  stderr: string,
  args: string[],
  exitCode: number,
): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const commandFailed = exitCode !== 0;
    throw new AppError(
      'COMMAND_FAILED',
      commandFailed ? 'agent-browser command failed' : 'agent-browser returned invalid JSON',
      {
        cmd: AGENT_BROWSER,
        args,
        ...(commandFailed ? { exitCode } : {}),
        stdout: stdout.slice(0, 500),
        stderr: stderr.slice(0, 500),
        hint: AGENT_BROWSER_DOCTOR_HINT,
      },
      error instanceof Error ? error : undefined,
    );
  }
}

function mapAgentBrowserRunError(error: unknown, args: string[]): AppError {
  const appError = mapManagedAgentBrowserError(error);
  if (appError.code === 'TOOL_MISSING') {
    return new AppError(
      'TOOL_MISSING',
      appError.message,
      {
        ...(appError.details ?? {}),
        cmd: AGENT_BROWSER,
        args,
        hint: webBackendHint(appError),
      },
      appError,
    );
  }
  if (appError.code === 'COMMAND_FAILED') {
    return new AppError(
      'COMMAND_FAILED',
      appError.message,
      {
        ...(appError.details ?? {}),
        cmd: AGENT_BROWSER,
        args,
        hint: webBackendHint(appError),
      },
      appError,
    );
  }
  return appError;
}

function webBackendHint(error: AppError): string {
  return typeof error.details?.hint === 'string' ? error.details.hint : AGENT_BROWSER_DOCTOR_HINT;
}

function readEnvelopeErrorMessage(envelope: JsonObject): string {
  const error = envelope.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (isJsonObject(error)) {
    const message = readStringProperty(error, 'message') ?? readStringProperty(error, 'error');
    if (message) return message;
  }
  return readStringProperty(envelope, 'message') ?? 'agent-browser command failed';
}

function toErrorCode(value: unknown): 'COMMAND_FAILED' | (string & {}) {
  return typeof value === 'string' && value.length > 0 ? value : 'COMMAND_FAILED';
}

function browserRefSelector(ref: string): string {
  return ref.startsWith('@') ? ref : `@${ref}`;
}

function selectAllShortcut(): string {
  return process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
}

function parseRect(data: unknown): Rect | undefined {
  const candidate = isJsonObject(data) && isJsonObject(data.box) ? data.box : data;
  if (!isJsonObject(candidate)) return undefined;
  return rectFromPointSize(candidate) ?? rectFromEdges(candidate);
}

function rectFromPointSize(candidate: JsonObject): Rect | undefined {
  const x = readNumberProperty(candidate, 'x');
  const y = readNumberProperty(candidate, 'y');
  const width = readNumberProperty(candidate, 'width');
  const height = readNumberProperty(candidate, 'height');
  return buildRect(x, y, width, height);
}

function rectFromEdges(candidate: JsonObject): Rect | undefined {
  const left = readNumberProperty(candidate, 'left');
  const top = readNumberProperty(candidate, 'top');
  const right = readNumberProperty(candidate, 'right');
  const bottom = readNumberProperty(candidate, 'bottom');
  return buildRect(left, top, diffNumbers(right, left), diffNumbers(bottom, top));
}

function buildRect(
  x: number | undefined,
  y: number | undefined,
  width: number | undefined,
  height: number | undefined,
): Rect | undefined {
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function diffNumbers(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a - b;
}
