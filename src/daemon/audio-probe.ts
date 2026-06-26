import fs from 'node:fs/promises';
import path from 'node:path';
import {
  emptyAudioProbeResult,
  normalizeAudioProbeRecord,
  type AudioProbeResult,
} from '../audio-probe-result.ts';
import { startMacOsAudioProbeProcess } from '../platforms/ios/macos-helper.ts';
import { AppError } from '../utils/errors.ts';
import { sleep } from '../utils/timeouts.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';

const HOST_AUDIO_BACKEND = 'macos-screencapturekit';

export type HostAudioProbeCommand = {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  probeAction: 'start' | 'status' | 'stop';
  durationMs: number;
  bucketMs: number;
};

export async function runHostSystemAudioProbeCommand(
  request: HostAudioProbeCommand,
): Promise<AudioProbeResult> {
  const { session, probeAction } = request;
  if (probeAction === 'start') {
    await stopSessionAudioProbe(session, 'restarted');
    const statusPath = path.join(
      request.sessionStore.ensureSessionDir(request.sessionName),
      'audio-probe.json',
    );
    const probe = await startMacOsAudioProbeProcess({
      durationMs: request.durationMs,
      bucketMs: request.bucketMs,
      statusPath,
    });
    session.audioProbe = {
      platform: 'host-system-audio',
      child: probe.child,
      wait: probe.wait,
      statusPath,
      startedAt: Date.now(),
      durationMs: request.durationMs,
      bucketMs: request.bucketMs,
    };
    void probe.wait.catch(() => {});
    return await waitForHostSystemAudioProbeStatus(session);
  }

  if (probeAction === 'stop') {
    return (
      (await stopSessionAudioProbe(session, 'stopped')) ??
      buildHostSystemAudioProbeFallback(request, 'stopped', 'not-started')
    );
  }

  const data = await readHostSystemAudioProbeStatus(session);
  if (data) {
    if (data.state === 'stopped') session.audioProbe = undefined;
    return data;
  }
  return buildHostSystemAudioProbeFallback(request, 'stopped', 'not-started');
}

export async function stopSessionAudioProbe(
  session: SessionState,
  reason = 'session-cleanup',
): Promise<AudioProbeResult | undefined> {
  const probe = session.audioProbe;
  if (!probe) return undefined;
  const beforeStop = await readHostSystemAudioProbeStatus(session);
  probe.child.kill('SIGTERM');
  await probe.wait.catch(() => {});
  session.audioProbe = undefined;
  return finalizeHostSystemAudioProbeStatus(beforeStop, probe, session.device, reason);
}

async function waitForHostSystemAudioProbeStatus(session: SessionState): Promise<AudioProbeResult> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = await readHostSystemAudioProbeStatus(session);
    if (status) return status;
    const exit = await Promise.race([
      session.audioProbe?.wait.then(
        (result) => result,
        (error: unknown) => error,
      ),
      sleep(100).then(() => undefined),
    ]);
    if (exit instanceof Error) throw exit;
    if (exit) {
      const result = exit as { stdout?: string; stderr?: string; exitCode?: number };
      const message =
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        `host audio probe helper exited with code ${result.exitCode ?? 1}`;
      throw new AppError('COMMAND_FAILED', `failed to start host audio probe: ${message}`);
    }
  }
  throw new AppError('COMMAND_FAILED', 'failed to start host audio probe');
}

async function readHostSystemAudioProbeStatus(
  session: SessionState,
): Promise<AudioProbeResult | undefined> {
  const probe = session.audioProbe;
  if (!probe) return undefined;
  try {
    const raw = await fs.readFile(probe.statusPath, 'utf8');
    return normalizeHostSystemAudioProbeData(JSON.parse(raw), probe, session.device);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function normalizeHostSystemAudioProbeData(
  value: unknown,
  probe: NonNullable<SessionState['audioProbe']>,
  device: SessionState['device'],
): AudioProbeResult {
  return normalizeAudioProbeRecord(value, {
    source: 'system-audio',
    backend: HOST_AUDIO_BACKEND,
    durationMs: probe.durationMs,
    elapsedMs: Date.now() - probe.startedAt,
    bucketMs: probe.bucketMs,
    activeFallback: true,
    sourceCount: 1,
    notes: hostSystemAudioProbeNotes(device),
  });
}

function finalizeHostSystemAudioProbeStatus(
  status: AudioProbeResult | undefined,
  probe: NonNullable<SessionState['audioProbe']>,
  device: SessionState['device'],
  reason: string,
): AudioProbeResult {
  const elapsedMs = Math.min(probe.durationMs, Math.max(0, Date.now() - probe.startedAt));
  const base =
    status ??
    emptyAudioProbeResult({
      source: 'system-audio',
      backend: HOST_AUDIO_BACKEND,
      durationMs: probe.durationMs,
      bucketMs: probe.bucketMs,
      sourceCount: 1,
      notes: hostSystemAudioProbeNotes(device),
    });
  return {
    ...base,
    state: 'stopped',
    active: false,
    elapsedMs,
    stoppedAt: new Date().toISOString(),
    reason,
  };
}

function buildHostSystemAudioProbeFallback(
  request: HostAudioProbeCommand,
  state: 'running' | 'stopped',
  reason?: string,
): AudioProbeResult {
  return emptyAudioProbeResult({
    state,
    source: 'system-audio',
    backend: HOST_AUDIO_BACKEND,
    durationMs: request.durationMs,
    bucketMs: request.bucketMs,
    sourceCount: 0,
    reason,
    notes: [
      ...hostSystemAudioProbeNotes(request.session.device),
      'No active host audio probe is running.',
    ],
  });
}

function hostSystemAudioProbeNotes(device: SessionState['device']): string[] {
  const target =
    device.platform === 'ios'
      ? 'iOS simulator'
      : device.platform === 'android'
        ? 'Android emulator'
        : 'macOS session';
  return [
    `Audio probe samples host system audio through ScreenCaptureKit for this ${target}; it is not app-instrumented audio.`,
    'Screen Recording permission is required for host system audio capture.',
    'Other audible host apps can contribute to the measured buckets.',
  ];
}
