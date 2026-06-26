import { normalizeAudioProbeRecord, type AudioProbeResult } from '../../audio-probe-result.ts';
import { isJsonObject, type JsonObject } from './json-utils.ts';
import type { WebAudioProbeOptions, WebAudioProbeResult } from './provider.ts';

const audioProbePageScriptFunctions = [
  audioProbeDbfs,
  audioProbeNote,
  audioProbeMediaElements,
  audioProbeStop,
  audioProbeGetContext,
  audioProbeCreateElementAudioSource,
  audioProbeCreateMediaStreamAudioSource,
  audioProbeCreateCaptureStreamAudioSource,
  audioProbeConnectSource,
  audioProbeDiscover,
  audioProbeReadStats,
  audioProbeTrimSamples,
  audioProbeSample,
  audioProbeStoppedResult,
  audioProbeResult,
  audioProbeStart,
  audioProbeEvalScript,
] as const;

export function buildAudioProbeEvalScript(options: WebAudioProbeOptions): string {
  const scriptBody = audioProbePageScriptFunctions.map((fn) => `${fn.toString()};`).join('');
  const action = audioProbeEvalActionLiteral(options.action);
  const durationMs = finiteNumberLiteralOrUndefined(options.durationMs);
  const bucketMs = finiteNumberLiteralOrUndefined(options.bucketMs);
  return `(()=>{${scriptBody}return ${audioProbeEvalScript.name}({action:${action},durationMs:${durationMs},bucketMs:${bucketMs}})})()`;
}

export function normalizeAgentBrowserAudioProbeResult(data: unknown): WebAudioProbeResult {
  const result: AudioProbeResult = normalizeAudioProbeRecord(
    readAgentBrowserEvalResultRecord(data),
    {
      source: 'media-elements',
      backend: 'agent-browser',
      durationMs: 0,
      elapsedMs: 0,
      bucketMs: 1000,
      activeFallback: false,
      mediaElementCount: 0,
      sourceCount: 0,
    },
  );
  return {
    ...result,
    source: 'media-elements',
    mediaElementCount: result.mediaElementCount ?? 0,
  };
}

type AudioProbePageRecord = Record<string, any>;
type AudioProbePageSource = { source: AudioProbePageRecord; audible: boolean };
type AudioProbePageStats = { rms: number; peak: number };

declare const window: AudioProbePageRecord;
declare const document: { querySelectorAll(selector: string): any[] };

function audioProbeEvalActionLiteral(
  action: WebAudioProbeOptions['action'],
): "'start'" | "'stop'" | "'status'" {
  switch (action) {
    case 'start':
      return "'start'";
    case 'stop':
      return "'stop'";
    default:
      return "'status'";
  }
}

function finiteNumberLiteralOrUndefined(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'undefined' : String(Math.trunc(value));
}

function audioProbeDbfs(value: number): number {
  const silenceDb = -90;
  if (!Number.isFinite(value) || value <= 0) return silenceDb;
  return Math.max(silenceDb, Math.min(0, Math.round(20 * Math.log10(value))));
}

function audioProbeNote(probe: AudioProbePageRecord, message: string): void {
  if (!probe.notes.includes(message)) probe.notes.push(message);
}

function audioProbeMediaElements(): AudioProbePageRecord[] {
  return Array.from(document.querySelectorAll('audio,video'));
}

function audioProbeStop(
  probe: AudioProbePageRecord | undefined,
  reason: string,
): AudioProbePageRecord | undefined {
  if (!probe || probe.state === 'stopped') return probe;
  clearInterval(probe.timer);
  clearTimeout(probe.timeout);
  probe.timer = undefined;
  probe.timeout = undefined;
  probe.state = 'stopped';
  probe.active = false;
  probe.reason = reason;
  probe.stoppedAt = Date.now();
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
}

function audioProbeGetContext(contextKey: string): AudioProbePageRecord | undefined {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return undefined;
  const existing = window[contextKey];
  if (existing && existing.state !== 'closed') return existing;
  const context = new AudioContextCtor();
  window[contextKey] = context;
  return context;
}

function audioProbeCreateElementAudioSource(
  probe: AudioProbePageRecord,
  element: AudioProbePageRecord,
  sourceKey: string,
): AudioProbePageSource | undefined {
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
}

function audioProbeCreateMediaStreamAudioSource(
  probe: AudioProbePageRecord,
  stream: AudioProbePageRecord | undefined,
): AudioProbePageSource | undefined {
  if (!stream || typeof stream.getAudioTracks !== 'function') return undefined;
  if (stream.getAudioTracks().length === 0) return undefined;
  return { source: probe.context.createMediaStreamSource(stream), audible: false };
}

function audioProbeCreateCaptureStreamAudioSource(
  probe: AudioProbePageRecord,
  element: AudioProbePageRecord,
): AudioProbePageSource | undefined {
  if (typeof element.captureStream !== 'function') return undefined;
  const stream = element.captureStream();
  return audioProbeCreateMediaStreamAudioSource(probe, stream);
}

function audioProbeConnectSource(
  probe: AudioProbePageRecord,
  sourceEntry: AudioProbePageSource,
): void {
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

function audioProbeDiscover(probe: AudioProbePageRecord, sourceKey: string): void {
  const elements = audioProbeMediaElements();
  probe.mediaElementCount = elements.length;
  for (const element of elements) {
    if (probe.seen.has(element)) continue;
    const sourceEntry =
      audioProbeCreateMediaStreamAudioSource(probe, element.srcObject) ??
      audioProbeCreateCaptureStreamAudioSource(probe, element) ??
      audioProbeCreateElementAudioSource(probe, element, sourceKey);
    if (!sourceEntry) {
      audioProbeNote(probe, 'Some media elements do not expose capturable audio to Web Audio.');
      continue;
    }
    probe.seen.add(element);
    audioProbeConnectSource(probe, sourceEntry);
  }
  probe.sourceCount = probe.analysers.length;
  if (probe.sourceCount === 0) {
    audioProbeNote(probe, 'No capturable page media audio sources were found yet.');
  }
}

function audioProbeReadStats(probe: AudioProbePageRecord): AudioProbePageStats {
  let totalSquares = 0;
  let totalSamples = 0;
  let peak = 0;
  for (const entry of probe.analysers) {
    entry.analyser.getFloatTimeDomainData(entry.buffer);
    for (const value of entry.buffer) {
      totalSquares += value * value;
      totalSamples += 1;
      peak = Math.max(peak, Math.abs(value));
    }
  }
  return {
    rms: totalSamples > 0 ? Math.sqrt(totalSquares / totalSamples) : 0,
    peak,
  };
}

function audioProbeTrimSamples(probe: AudioProbePageRecord): void {
  const maxSamples = Math.ceil(probe.durationMs / probe.bucketMs) + 2;
  if (probe.rmsDbfs.length > maxSamples) probe.rmsDbfs.splice(0, probe.rmsDbfs.length - maxSamples);
  if (probe.peakDbfs.length > maxSamples)
    probe.peakDbfs.splice(0, probe.peakDbfs.length - maxSamples);
}

function audioProbeSample(probe: AudioProbePageRecord | undefined, sourceKey: string): void {
  if (!probe || probe.state !== 'running') return;
  audioProbeDiscover(probe, sourceKey);
  const stats = audioProbeReadStats(probe);
  const rmsDb = audioProbeDbfs(stats.rms);
  const peakDb = audioProbeDbfs(stats.peak);
  probe.rmsDbfs.push(rmsDb);
  probe.peakDbfs.push(peakDb);
  probe.heard = probe.heard || rmsDb > -90 || peakDb > -90;
  audioProbeTrimSamples(probe);
  if (Date.now() - probe.startedAt >= probe.durationMs) audioProbeStop(probe, 'duration');
}

function audioProbeStoppedResult(
  options: AudioProbePageRecord,
  notes: string[],
): AudioProbePageRecord {
  return {
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
    mediaElementCount: audioProbeMediaElements().length,
    sourceCount: 0,
    rmsDbfs: [],
    peakDbfs: [],
    notes,
  };
}

function audioProbeResult(
  probe: AudioProbePageRecord | undefined,
  options: AudioProbePageRecord,
  scopeNote: string,
  routingNote: string,
): AudioProbePageRecord {
  if (!probe) return audioProbeStoppedResult(options, [scopeNote, routingNote]);
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
      Math.min((probe.stoppedAt || Date.now()) - probe.startedAt, probe.durationMs),
    ),
    bucketMs: probe.bucketMs,
    sampleCount: probe.rmsDbfs.length,
    mediaElementCount: audioProbeMediaElements().length,
    sourceCount: probe.sourceCount,
    rmsDbfs: probe.rmsDbfs.slice(),
    peakDbfs: probe.peakDbfs.slice(),
    startedAt: new Date(probe.startedAt).toISOString(),
    stoppedAt: probe.stoppedAt ? new Date(probe.stoppedAt).toISOString() : undefined,
    reason: probe.reason,
    notes: [scopeNote, routingNote, ...probe.notes],
  };
}

function audioProbeStart(
  options: AudioProbePageRecord,
  existingProbe: AudioProbePageRecord | undefined,
  probeKey: string,
  contextKey: string,
  sourceKey: string,
  scopeNote: string,
  routingNote: string,
): AudioProbePageRecord {
  if (existingProbe) audioProbeStop(existingProbe, 'restarted');
  const context = audioProbeGetContext(contextKey);
  if (!context) {
    return audioProbeStoppedResult(options, [
      'Web Audio API is not available in this browser context.',
    ]);
  }
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);
  const probe: AudioProbePageRecord = {
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
    startedAt: Date.now(),
    stoppedAt: undefined,
    reason: undefined,
    heard: false,
    rmsDbfs: [],
    peakDbfs: [],
    notes: [],
  };
  try {
    void context.resume();
  } catch {
    audioProbeNote(probe, 'AudioContext could not be resumed by the probe.');
  }
  probe.resumeOnGesture = () => {
    try {
      void context.resume();
    } catch {
      audioProbeNote(probe, 'AudioContext could not be resumed from a user gesture.');
    }
  };
  for (const eventName of ['click', 'pointerdown', 'keydown']) {
    window.addEventListener(eventName, probe.resumeOnGesture, { capture: true, once: true });
  }
  audioProbeDiscover(probe, sourceKey);
  probe.timer = setInterval(() => audioProbeSample(probe, sourceKey), probe.bucketMs);
  probe.timeout = setTimeout(() => audioProbeStop(probe, 'duration'), probe.durationMs);
  window[probeKey] = probe;
  return audioProbeResult(probe, options, scopeNote, routingNote);
}

function audioProbeEvalScript(options: AudioProbePageRecord): unknown {
  const key = '__agentDeviceAudioProbe';
  const contextKey = '__agentDeviceAudioProbeContext';
  const sourceKey = '__agentDeviceAudioProbeSources';
  const scopeNote =
    'Audio probe samples HTML media elements exposed to Web Audio; it is not whole-tab or system audio capture.';
  const routingNote =
    'URL-backed media elements may be routed through the probe AudioContext while they are observed.';
  const probe = window[key];
  if (probe && probe.state === 'running' && Date.now() - probe.startedAt >= probe.durationMs) {
    audioProbeSample(probe, sourceKey);
    audioProbeStop(probe, 'duration');
  }
  if (options.action === 'start') {
    return audioProbeStart(options, probe, key, contextKey, sourceKey, scopeNote, routingNote);
  }
  if (options.action === 'stop') {
    if (probe) audioProbeSample(probe, sourceKey);
    audioProbeStop(probe, 'manual');
    return audioProbeResult(probe, options, scopeNote, routingNote);
  }
  if (probe) audioProbeSample(probe, sourceKey);
  return audioProbeResult(probe, options, scopeNote, routingNote);
}

function readAgentBrowserEvalResultRecord(data: unknown): JsonObject {
  if (!isJsonObject(data)) return {};
  return isJsonObject(data.result) ? data.result : data;
}
