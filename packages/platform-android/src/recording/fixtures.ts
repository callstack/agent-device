import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';

import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';

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
  const store =
    (overrides as { files?: ReturnType<typeof recordingFileStore> }).files ?? recordingFileStore();
  // The device's own files, so `exists` answers what a disposal did or failed to do rather than
  // always agreeing that an artifact is still there.
  const deviceFiles = new Set<string>();
  const markers = new Map<string, string>();
  const legacy = overrides as Record<string, any>;
  if (legacy.initialManifest)
    markers.set(
      '/sdcard/agent-device-recording-active.json',
      JSON.stringify(legacy.initialManifest),
    );
  const read = async (manifestPath: string) => {
    const external = legacy.readManifest
      ? await legacy.readManifest(manifestPath)
      : { status: 'missing' as const };
    if (external.status !== 'missing' || !markers.has(manifestPath)) return external;
    return { status: 'read' as const, contents: markers.get(manifestPath)! };
  };
  const transport = {
    ...overrides,
    mode: legacy.mode ?? ('local' as const),
    start: async ({
      remotePath,
      quality,
      admission,
    }: {
      remotePath: string;
      quality: 'medium' | 'high';
      admission: { manifestPath: string; expected: string; admitted: string };
    }) => {
      const current = await read(admission.manifestPath);
      if (current.status !== 'read' || current.contents !== admission.expected)
        throw new Error('launch admission rejected');
      markers.set(admission.manifestPath, admission.admitted);
      if (legacy.writeManifest)
        await legacy.writeManifest({
          manifestPath: admission.manifestPath,
          contents: admission.admitted,
        });
      const started = await (legacy.start?.({ remotePath, quality }) ??
        recordingProcess('42', remotePath));
      deviceFiles.add(remotePath);
      return 'process' in started
        ? { process: { ...started.process, remotePath } }
        : recordingProcess(started.remotePid, remotePath);
    },
    exists: async (remotePath: string) =>
      legacy.exists ? await legacy.exists(remotePath) : deviceFiles.has(remotePath),
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
      if (legacy.stop) {
        const result = await legacy.stop(processIdentity, options);
        if (result === 'stopped' || result === 'already-missing') stopped.add(processIdentity.pid);
        return result;
      }
      if (legacy.signal) {
        const ok = await legacy.signal({ pid: processIdentity.pid, force: options?.force });
        if (ok) stopped.add(processIdentity.pid);
        return ok ? ('stopped' as const) : ('uncertain' as const);
      }
      if (stopped.has(processIdentity.pid)) return 'already-missing' as const;
      stopped.add(processIdentity.pid);
      return 'stopped' as const;
    },
    pullPlayable: async (input: { remotePath: string; outputPath: string }) => {
      const pulled = legacy.pullPlayable
        ? await legacy.pullPlayable(input)
        : legacy.pull
          ? { ...(await legacy.pull(input)), playable: true }
          : { stdout: '', stderr: '', exitCode: 0, playable: true };
      // A pull that succeeded left a file on the host, and the stop copies from that file. Modelling
      // it here is what makes a stop that pulls from nowhere fail instead of quietly succeeding.
      if (pulled.exitCode === 0) store.files.set(input.outputPath, 'pulled');
      return pulled;
    },
    remove: async (remotePath: string) => {
      const removed = legacy.remove ? await legacy.remove(remotePath) : true;
      if (removed) deviceFiles.delete(remotePath);
      return removed;
    },
    manifestPathFor: (remotePath: string) =>
      legacy.manifestPathFor?.(remotePath) ??
      `${remotePath.slice(0, remotePath.lastIndexOf('/'))}/agent-device-recording-active.json`,
    readManifest: read,
    writeManifest: async (
      request: { manifestPath: string; contents: string },
      signal?: AbortSignal,
    ) => {
      await legacy.writeManifest?.(request, signal);
    },
    compareAndSetManifest: async (
      request: { manifestPath: string; expected: string | null; contents: string | null },
      signal?: AbortSignal,
    ) => {
      if (legacy.compareAndSetManifest) return await legacy.compareAndSetManifest(request, signal);
      const current = await read(request.manifestPath);
      if (
        (current.status === 'missing'
          ? null
          : current.status === 'read'
            ? current.contents
            : undefined) !== request.expected
      )
        return 'mismatch' as const;
      if (request.contents === null) {
        if (legacy.removeManifest && !(await legacy.removeManifest(request.manifestPath)))
          return 'unavailable' as const;
        markers.delete(request.manifestPath);
      } else {
        await legacy.writeManifest?.(
          { manifestPath: request.manifestPath, contents: request.contents },
          signal,
        );
        markers.set(request.manifestPath, request.contents);
      }
      return 'updated' as const;
    },
    removeManifest: async (manifestPath: string) => {
      const removed = legacy.removeManifest ? await legacy.removeManifest(manifestPath) : true;
      if (removed) markers.delete(manifestPath);
      return removed;
    },
    probeRunningWriters: async (remotePath: string) => {
      const found = await (legacy.findRunning?.(remotePath) ?? []);
      if (!Array.isArray(found)) return found;
      return {
        writers: found.map(
          (entry: string | { pid: string; remotePath: string; startTime: string }) =>
            typeof entry === 'string' ? { pid: entry, remotePath, startTime: '1' } : entry,
        ),
        conclusive: true,
      };
    },
  };
  return {
    screenRecording: {
      android: { resolve: async () => transport },
      outputs: Object.assign({}, store.outputs, legacy.outputs),
      finalize: Object.assign(
        { prepare: async () => {}, sniff: async () => {}, complete: async () => ({}) },
        legacy.finalize,
      ),
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
