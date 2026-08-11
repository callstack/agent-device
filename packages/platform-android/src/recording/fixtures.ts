import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';

export const androidRecordingDevice = {
  platform: 'android' as const,
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator' as const,
  target: 'mobile' as const,
  booted: true,
};

export function recordingInput() {
  return {
    sessionId: 'one',
    outputPath: '/tmp/capture.mp4',
    scope: 'device' as const,
    showTouches: true,
    hideTouchesRequested: false,
    recordOnlySession: false,
    fence: { token: 'fence-1', generation: 2 },
  };
}

export function recordingHost(overrides: Record<string, unknown>): PlatformRuntimeHost {
  const stopped = new Set<string>();
  const legacy = overrides as Record<string, any>;
  const transport = {
    ...overrides,
    mode: legacy.mode ?? ('local' as const),
    start: async ({ remotePath, quality }: { remotePath: string; quality: 'medium' | 'high' }) => {
      const started = await (legacy.start?.({ remotePath, quality }) ??
        recordingProcess('42', remotePath));
      return 'process' in started
        ? { process: { ...started.process, remotePath } }
        : recordingProcess(started.remotePid, remotePath);
    },
    exists: async (remotePath: string) => (legacy.exists ? await legacy.exists(remotePath) : true),
    size: async (remotePath: string) => (legacy.size ? await legacy.size(remotePath) : 1),
    inspect: async (processIdentity: { pid: string }) =>
      legacy.inspect
        ? await legacy.inspect(processIdentity)
        : legacy.isRunning
          ? (await legacy.isRunning(processIdentity.pid))
            ? 'owned-alive'
            : 'missing'
          : stopped.has(processIdentity.pid)
            ? 'missing'
            : 'owned-alive',
    stop: async (processIdentity: { pid: string }, options?: { force?: boolean }) => {
      if (legacy.stop) return await legacy.stop(processIdentity, options);
      if (legacy.signal) {
        const ok = await legacy.signal({ pid: processIdentity.pid, force: options?.force });
        return ok ? ('stopped' as const) : ('uncertain' as const);
      }
      if (stopped.has(processIdentity.pid)) return 'already-missing' as const;
      stopped.add(processIdentity.pid);
      return 'stopped' as const;
    },
    pullPlayable: async (input: { remotePath: string; outputPath: string }) =>
      legacy.pullPlayable
        ? await legacy.pullPlayable(input)
        : legacy.pull
          ? { ...(await legacy.pull(input)), playable: true }
          : { stdout: '', stderr: '', exitCode: 0, playable: true },
    remove: async (remotePath: string) => (legacy.remove ? await legacy.remove(remotePath) : true),
    manifestPathFor: (remotePath: string) =>
      legacy.manifestPathFor?.(remotePath) ??
      `${remotePath.slice(0, remotePath.lastIndexOf('/'))}/agent-device-recording-active.json`,
    readManifest: async (manifestPath: string) =>
      legacy.readManifest
        ? await legacy.readManifest(manifestPath)
        : { status: 'missing' as const },
    writeManifest: async (request: { manifestPath: string; contents: string }) => {
      await legacy.writeManifest?.(request);
    },
    removeManifest: async (manifestPath: string) =>
      legacy.removeManifest ? await legacy.removeManifest(manifestPath) : true,
    findRunning: async (remotePath: string) => {
      const found = await (legacy.findRunning?.(remotePath) ?? ['42', '43', '66']);
      return found.map((entry: string | { pid: string; remotePath: string; startTime: string }) =>
        typeof entry === 'string' ? { pid: entry, remotePath, startTime: '1' } : entry,
      );
    },
  };
  return {
    screenRecording: {
      android: { resolve: async () => transport },
      outputs: legacy.outputs ?? { prepare: async () => {} },
      finalize: legacy.finalize ?? { complete: async () => ({}) },
    },
  } as unknown as PlatformRuntimeHost;
}

export function recordingProcess(
  remotePid: string,
  remotePath = '/sdcard/agent-device-recording-1.mp4',
) {
  return {
    process: { pid: remotePid, remotePath, startTime: '1' },
  };
}
