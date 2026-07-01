import fs from 'node:fs/promises';
import path from 'node:path';
import {
  emptyAudioProbeResult,
  normalizeAudioProbeRecord,
  type AudioProbeResult,
} from '../audio-probe-result.ts';
import type { HostAudioProbeBackend } from '../platforms/audio-probe-backend.ts';
import { AppError } from '../kernel/errors.ts';
import { sleep } from '../utils/timeouts.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';

export type HostAudioProbeCommand = {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  backend: HostAudioProbeBackend;
  probeAction: 'start' | 'status' | 'stop';
  durationMs: number;
  bucketMs: number;
};

export async function runHostSystemAudioProbeCommand(
  request: HostAudioProbeCommand,
): Promise<AudioProbeResult> {
  const { session, probeAction, backend } = request;
  if (probeAction === 'start') {
    await stopSessionAudioProbe(session, 'restarted');
    const statusPath = path.join(
      request.sessionStore.ensureSessionDir(request.sessionName),
      'audio-probe.json',
    );
    const probe = await backend.start({
      durationMs: request.durationMs,
      bucketMs: request.bucketMs,
      statusPath,
    });
    session.audioProbe = {
      platform: backend.platform,
      source: backend.source,
      backend: backend.backend,
      sourceCount: backend.sourceCount,
      notes: backend.notes(session.device),
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
  return finalizeHostSystemAudioProbeStatus(beforeStop, probe, reason);
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
    return normalizeHostSystemAudioProbeData(JSON.parse(raw), probe);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function normalizeHostSystemAudioProbeData(
  value: unknown,
  probe: NonNullable<SessionState['audioProbe']>,
): AudioProbeResult {
  return normalizeAudioProbeRecord(value, {
    source: probe.source,
    backend: probe.backend,
    durationMs: probe.durationMs,
    elapsedMs: Date.now() - probe.startedAt,
    bucketMs: probe.bucketMs,
    activeFallback: true,
    sourceCount: probe.sourceCount,
    notes: probe.notes,
  });
}

function finalizeHostSystemAudioProbeStatus(
  status: AudioProbeResult | undefined,
  probe: NonNullable<SessionState['audioProbe']>,
  reason: string,
): AudioProbeResult {
  const elapsedMs = Math.min(probe.durationMs, Math.max(0, Date.now() - probe.startedAt));
  const base =
    status ??
    emptyAudioProbeResult({
      source: probe.source,
      backend: probe.backend,
      durationMs: probe.durationMs,
      bucketMs: probe.bucketMs,
      sourceCount: probe.sourceCount,
      notes: probe.notes,
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
    source: request.backend.source,
    backend: request.backend.backend,
    durationMs: request.durationMs,
    bucketMs: request.bucketMs,
    sourceCount: 0,
    reason,
    notes: [
      ...request.backend.notes(request.session.device),
      'No active host audio probe is running.',
    ],
  });
}
