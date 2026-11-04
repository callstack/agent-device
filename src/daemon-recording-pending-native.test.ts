import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import * as deviceSelection from '@agent-device/device-selection/dispatch-resolve';
import { ANDROID_EMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { createAndroidRuntimeModule } from '@agent-device/platform-android';
import type { AndroidScreenRecordingTransport } from '@agent-device/contracts/screen-recording-runtime-host';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { startDaemonRuntime } from '@agent-device/daemon';
import {
  createPlatformRuntimeHost,
  createSnapshotRuntimeHost,
} from './platform-runtime-operation-host.ts';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import {
  recordingDaemonDeps,
  recordingDaemonHost,
} from './__tests__/test-utils/recording-daemon.ts';

test('the authenticated daemon keeps the actual Android admission and export until release is confirmed', async () => {
  const root = mkdtempForTestSync('daemon-android-pending-');
  const stateDir = path.join(root, 'state');
  const host = recordingDaemonHost({
    cwd: root,
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    },
  });
  const markers = new Map<string, string>();
  const files = new Set<string>();
  let admission: string | undefined;
  let writer = false;
  let allowRelease = false;
  const launched: string[] = [];
  const transport: AndroidScreenRecordingTransport = {
    mode: 'local',
    acquireAdmission: async (owner) => {
      if (admission) return 'busy';
      admission = owner;
      return 'acquired';
    },
    releaseAdmission: async ({ owner, manifestPath, expected }) => {
      if (!allowRelease) return 'unavailable';
      if ((markers.get(manifestPath) ?? null) !== expected || admission !== owner)
        return 'not-owner';
      admission = undefined;
      return 'released';
    },
    start: async ({ remotePath, admission: request }) => {
      if (admission !== request.owner || markers.get(request.manifestPath) !== request.expected)
        throw new Error('native admission did not match');
      markers.set(request.manifestPath, request.admitted);
      writer = true;
      files.add(remotePath);
      launched.push(remotePath);
      return { process: { pid: '42', startTime: '100', remotePath } };
    },
    inspect: async () => (writer ? 'owned-alive' : 'missing'),
    stop: async () => {
      writer = false;
      return 'stopped';
    },
    exists: async (remotePath) => files.has(remotePath),
    size: async (remotePath) => (files.has(remotePath) ? 12 : undefined),
    probeRunningWriters: async (remotePath) => ({
      conclusive: true,
      writers: writer ? [{ pid: '42', startTime: '100', remotePath }] : [],
    }),
    pullPlayable: async ({ outputPath }) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, 'native video');
      return { stdout: '', stderr: '', exitCode: 0, playable: true };
    },
    remove: async (remotePath) => {
      files.delete(remotePath);
      return true;
    },
    manifestPathFor: (remotePath) => {
      const match = /^agent-device-recording-v2-admitted-([a-f0-9]{64})-\d{1,20}\.mp4$/.exec(
        path.posix.basename(remotePath),
      );
      if (!match || path.posix.dirname(remotePath) !== '/sdcard')
        throw new Error('unexpected generation path');
      return `/sdcard/agent-device-recording-v2-admitted-${match[1]}.json`;
    },
    readManifest: async (manifestPath) => {
      const contents = markers.get(manifestPath);
      return contents === undefined ? { status: 'missing' } : { status: 'read', contents };
    },
    compareAndSetManifest: async ({ manifestPath, expected, contents }) => {
      if ((markers.get(manifestPath) ?? null) !== expected) return 'mismatch';
      if (contents === null) markers.delete(manifestPath);
      else markers.set(manifestPath, contents);
      return 'updated';
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('unused fixture port');
  };
  const baseHost = createPlatformRuntimeHost({
    host,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionArtifacts: () => ({
      outputPath: path.join(root, 'unused.log'),
      pidPath: path.join(root, 'unused.pid'),
    }),
    shutdownLoaders: { apple: unsupported, android: unsupported },
    snapshot: createSnapshotRuntimeHost({ linux: unsupported, macos: unsupported }),
  });
  const operationHost = {
    ...baseHost,
    androidTools: {
      ...baseHost.androidTools,
      probeClipboardShellSupport: async () => 'unsupported' as const,
    },
    screenRecording: {
      ...baseHost.screenRecording,
      android: { resolve: async () => transport },
      finalize: { prepare: async () => {}, sniff: async () => {}, complete: async () => ({}) },
    },
  };
  const gateway = createComposedPlatformRuntimeGateway({
    modules: new Map([['android', createAndroidRuntimeModule({ bindAdbHost: async () => {} })]]),
    loadHost: async () => operationHost,
  });
  const baseDeps = recordingDaemonDeps(() => gateway);
  const selection = vi
    .spyOn(deviceSelection, 'resolveTargetDevice')
    .mockResolvedValue(ANDROID_EMULATOR);
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> | undefined;
  const output = path.join(root, 'output.mp4');
  try {
    runtime = await startDaemonRuntime({
      host,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      composeDeps: async (input) => {
        const deps = await baseDeps(input);
        const services = deps.requestRouter.platformServices;
        if (!services) throw new Error('missing composed platform services');
        return {
          ...deps,
          claimRecoveryGateway: () => gateway,
          requestRouter: {
            ...deps.requestRouter,
            platformServices: { ...services, ensureLocalDeviceReady: async () => true },
          },
        };
      },
    });
    const rpc = async (
      session: string,
      action: 'start' | 'stop',
      flags: Record<string, unknown>,
    ) => {
      const response = await fetch(`http://127.0.0.1:${runtime!.httpPort}/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${runtime!.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `${session}-${action}`,
          method: 'agent_device.command',
          params: {
            session,
            command: 'record',
            positionals:
              action === 'start' && typeof flags.out === 'string' ? [action, flags.out] : [action],
            flags,
          },
        }),
      });
      const body = await response.json();
      return { status: response.status, body };
    };
    expect(
      await rpc('recording', 'start', {
        platform: 'android',
        serial: ANDROID_EMULATOR.id,
        out: output,
        recordingScope: 'device',
      }),
    ).toMatchObject({ status: 200, body: { result: { ok: true } } });
    expect(launched).toHaveLength(1);
    expect(await rpc('recording', 'stop', { recordingScope: 'device' })).toMatchObject({
      status: 200,
      body: { result: { ok: true, data: { outPath: output } } },
    });
    expect(fs.readFileSync(output, 'utf8')).toBe('native video');
    const claim = inspectDeviceClaims({}, host.env)[0]!.claim!;
    expect(claim).toMatchObject({ recordingCleanupPending: true });
    const resourcePath = screenRecordingResourceStore.resolvePath(
      path.join(stateDir, 'sessions', 'recording'),
    );
    expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open', metadata: { cleanupStatus: 'cleanup-pending' } },
    });
    expect(admission).toBeTruthy();
    expect(await rpc('recording', 'stop', { recordingScope: 'invalid' })).toMatchObject({
      status: 400,
      body: { error: { data: { code: 'INVALID_ARGS' } } },
    });
    expect(inspectDeviceClaims({}, host.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    expect(
      await rpc('competitor', 'start', {
        platform: 'android',
        serial: ANDROID_EMULATOR.id,
        out: path.join(root, 'other.mp4'),
        recordingScope: 'device',
      }),
    ).toMatchObject({ status: 500, body: { error: { data: { code: 'DEVICE_IN_USE' } } } });
    expect(launched).toHaveLength(1);
    expect(await rpc('recording', 'stop', { recordingScope: 'device' })).toMatchObject({
      status: 200,
      body: { result: { ok: true, data: { outPath: output } } },
    });
    expect(inspectDeviceClaims({}, host.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    allowRelease = true;
    expect(await rpc('recording', 'stop', { recordingScope: 'device' })).toMatchObject({
      status: 200,
      body: { result: { ok: true, data: { outPath: output } } },
    });
    expect(admission).toBeUndefined();
    expect(inspectDeviceClaims({}, host.env)).toHaveLength(0);
    expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'completed' },
    });
    expect(fs.readFileSync(output, 'utf8')).toBe('native video');
  } finally {
    allowRelease = true;
    selection.mockRestore();
    await runtime?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
