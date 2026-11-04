import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import * as deviceSelection from '@agent-device/device-selection/dispatch-resolve';
import { ANDROID_EMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { createAndroidRuntimeModule } from '@agent-device/platform-android';
import type { AndroidScreenRecordingTransport } from '@agent-device/contracts/screen-recording-runtime-host';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { startDaemonRuntime } from '@agent-device/daemon';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { readProcessIdentityFacts } from '@agent-device/host-kit/process';
import {
  runCmd,
  withCommandExecutorOverride,
  withoutCommandExecutorOverride,
} from '@agent-device/host-kit/command';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';
import { createVideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';
import {
  createPlatformRuntimeHost,
  createSnapshotRuntimeHost,
} from './platform-runtime-operation-host.ts';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import {
  recordingDaemonDeps,
  recordingDaemonHost,
} from './__tests__/test-utils/recording-daemon.ts';

const finalizerClock = vi.hoisted(() => ({ expired: false }));
vi.mock(import('@agent-device/capture-kit/recording-overlay'), async (original) => {
  const actual = await original();
  return {
    ...actual,
    startRecordingOverlayBudget: () => {
      const deadline = actual.startRecordingOverlayBudget();
      const remaining = deadline.remainingMs.bind(deadline);
      Object.defineProperty(deadline, 'remainingMs', {
        value: () => (finalizerClock.expired ? 0 : remaining()),
      });
      return deadline;
    },
  };
});

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

test.skipIf(process.platform !== 'darwin').each(['deadline-warning', 'request-canceled'] as const)(
  'daemon claim follows the actual finalizer while a private helper child writes late: %s',
  async (mode) => {
    const root = mkdtempForTestSync('daemon-finalizer-claim-');
    const stateDir = path.join(root, 'state');
    const cache = path.join(root, 'cache');
    const sentinel = path.join(root, 'sentinel');
    fs.mkdirSync(sentinel);
    fs.writeFileSync(path.join(sentinel, 'sentinel'), 'unchanged');
    const host = recordingDaemonHost({
      cwd: root,
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
    });
    const markers = new Map<string, string>();
    const files = new Set<string>();
    let admission: string | undefined;
    let writer = false;
    const raw = Buffer.from('0000000c6674797069736f6d000000086d6f6f76', 'hex');
    const transport: AndroidScreenRecordingTransport = {
      mode: 'local',
      acquireAdmission: async (owner) => {
        if (admission) return 'busy';
        admission = owner;
        return 'acquired';
      },
      releaseAdmission: async ({ owner, manifestPath, expected }) => {
        if ((markers.get(manifestPath) ?? null) !== expected || admission !== owner)
          return 'not-owner';
        admission = undefined;
        return 'released';
      },
      start: async ({ remotePath, admission: request }) => {
        if (admission !== request.owner || markers.get(request.manifestPath) !== request.expected)
          throw new Error('admission mismatch');
        markers.set(request.manifestPath, request.admitted);
        writer = true;
        files.add(remotePath);
        return { process: { pid: '42', startTime: '100', remotePath } };
      },
      inspect: async () => (writer ? 'owned-alive' : 'missing'),
      stop: async () => {
        writer = false;
        return 'stopped';
      },
      exists: async (remotePath) => files.has(remotePath),
      size: async (remotePath) => (files.has(remotePath) ? raw.length : undefined),
      probeRunningWriters: async (remotePath) => ({
        conclusive: true,
        writers: writer ? [{ pid: '42', startTime: '100', remotePath }] : [],
      }),
      pullPlayable: async ({ outputPath }) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, raw);
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
    const validator = {
      prepare: async () => ({ kind: 'container' as const }),
      read: () => Promise.resolve({ kind: 'container' as const }),
      close: async () => {},
    };
    const operationHost = {
      ...baseHost,
      androidTools: {
        ...baseHost.androidTools,
        probeClipboardShellSupport: async () => 'unsupported' as const,
      },
      screenRecording: {
        ...baseHost.screenRecording,
        android: { resolve: async () => transport },
        finalize: createScreenRecordingFinalizer(host, validator),
      },
    };
    const originalGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([['android', createAndroidRuntimeModule({ bindAdbHost: async () => {} })]]),
      loadHost: async () => operationHost,
    });
    let finishError: unknown;
    let finishFailed!: () => void;
    const finishFailure = new Promise<void>((resolve) => {
      finishFailed = resolve;
    });
    const gateway = {
      ...originalGateway,
      bind: async (request: Parameters<typeof originalGateway.bind>[0]) => {
        const binding = await originalGateway.bind(request);
        const start = binding.operations.screenRecordingStart;
        if (!start) return binding;
        return {
          ...binding,
          operations: {
            ...binding.operations,
            screenRecordingStart: async (input: Parameters<typeof start>[0]) => {
              const result = await start(input);
              const handle = result.pendingHandle.transfer();
              handle.appendGestureEvents([{ kind: 'tap', tMs: 0, x: 1, y: 1 }]);
              const observed = {
                ...handle,
                finish: async (...args: Parameters<typeof handle.finish>) => {
                  try {
                    return await handle.finish(...args);
                  } catch (error) {
                    finishError = error;
                    finishFailed();
                    throw error;
                  }
                },
              };
              return { ...result, pendingHandle: new PendingTransferGuard(observed) };
            },
          },
        };
      },
    };
    const baseDeps = recordingDaemonDeps(() => gateway);
    const selection = vi
      .spyOn(deviceSelection, 'resolveTargetDevice')
      .mockResolvedValue(ANDROID_EMULATOR);
    let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let childExit: Promise<unknown> | undefined;
    let childIdentity: { pid: number; startTime: string } | undefined;
    let childOutput = '';
    let helperEntered!: () => void;
    let releaseHelper: (() => void) | undefined;
    const helperStarted = new Promise<void>((resolve) => {
      helperEntered = resolve;
    });
    const output = path.join(root, 'output.mp4');
    const requestId = `finalizer-${mode}`;
    finalizerClock.expired = false;
    try {
      await withCommandExecutorOverride(
        async (command, args, options) => {
          if (command === 'xcrun' && args[1] === 'swiftc') {
            fs.writeFileSync(args[args.indexOf('-o') + 1]!, 'compiled helper', { mode: 0o755 });
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (args.includes('--input') && args.includes('--output')) {
            const privateOutput = args[args.indexOf('--output') + 1]!;
            fs.writeFileSync(privateOutput, raw);
            child = spawn(
              process.execPath,
              [
                '-e',
                String.raw`
            const fs = require('node:fs'); const target = process.argv[1];
            const fd = fs.openSync(target, 'a'); process.stdout.write('ready\n');
            process.stdin.once('data', () => {
              fs.writeSync(fd, 'late'); fs.closeSync(fd);
              try { fs.writeFileSync(target, 'late path'); process.stdout.write('path-open\n'); }
              catch (error) { process.stdout.write(String(error.code) + '\n'); }
            });
          `,
                privateOutput,
              ],
              { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
            );
            childExit = once(child, 'exit');
            child.stdout.on('data', (chunk) => {
              childOutput += String(chunk);
            });
            await once(child.stdout, 'data');
            if (!child.pid) throw new Error('test child has no pid');
            const facts = await withoutCommandExecutorOverride(() =>
              readProcessIdentityFacts(child!.pid!),
            );
            if (!facts.startTime) throw new Error('test child has no start identity');
            childIdentity = { pid: child.pid, startTime: facts.startTime };
            fs.writeFileSync(path.join(root, 'owned-child.json'), JSON.stringify(childIdentity));
            helperEntered();
            if (mode === 'deadline-warning') {
              finalizerClock.expired = true;
              throw new Error('controlled helper deadline');
            }
            await new Promise<void>((resolve) => {
              releaseHelper = resolve;
              if (!options.signal) throw new Error('helper received no stop signal');
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            throw createRequestCanceledError();
          }
          return await withoutCommandExecutorOverride(() => runCmd(command, args, options));
        },
        async () => {
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
            action: 'start' | 'stop',
            signal?: AbortSignal,
            session = 'recording',
          ) => {
            const response = await fetch(`http://127.0.0.1:${runtime!.httpPort}/rpc`, {
              method: 'POST',
              signal,
              headers: {
                authorization: `Bearer ${runtime!.token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: `${mode}-${action}`,
                method: 'agent_device.command',
                params: {
                  session,
                  command: 'record',
                  positionals: action === 'start' ? [action, output] : [action],
                  flags: {
                    platform: 'android',
                    serial: ANDROID_EMULATOR.id,
                    recordingScope: 'device',
                  },
                  meta: { requestId: action === 'stop' ? requestId : `${requestId}-start` },
                },
              }),
            });
            return { status: response.status, body: await response.json() };
          };
          expect(await rpc('start')).toMatchObject({ status: 200, body: { result: { ok: true } } });
          const original = inspectDeviceClaims({}, host.env)[0]!.claim!;
          const cancel = new AbortController();
          const stopping = rpc('stop', cancel.signal).then(
            (value) => ({ kind: 'response' as const, value }),
            (error: unknown) => ({ kind: 'disconnected' as const, error }),
          );
          expect(
            await Promise.race([
              helperStarted.then(() => 'helper'),
              stopping.then(() => 'stopped'),
            ]),
          ).toBe('helper');
          if (mode === 'request-canceled') cancel.abort();
          const stopped = await stopping;
          const resourcePath = screenRecordingResourceStore.resolvePath(
            path.join(stateDir, 'sessions', 'recording'),
          );
          if (mode === 'deadline-warning') {
            expect(stopped).toMatchObject({
              kind: 'response',
              value: {
                status: 200,
                body: {
                  result: {
                    ok: true,
                    data: { outPath: output, overlayWarning: expect.stringContaining('budget') },
                  },
                },
              },
            });
            expect(fs.readFileSync(output)).toEqual(raw);
            expect(inspectDeviceClaims({}, host.env)).toHaveLength(0);
            expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
              status: 'decoded',
              envelope: { lifecycle: 'completed' },
            });
          } else {
            expect(stopped).toMatchObject({ kind: 'disconnected', error: { name: 'AbortError' } });
            await finishFailure;
            expect(finishError).toMatchObject({ details: { reason: 'request_canceled' } });
            expect(await rpc('start', undefined, 'competitor')).toMatchObject({
              body: { error: { data: { code: 'DEVICE_IN_USE' } } },
            });
            expect(inspectDeviceClaims({}, host.env)[0]?.claim?.ownerToken).toBe(
              original.ownerToken,
            );
            expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
              status: 'decoded',
              envelope: { lifecycle: 'open' },
            });
            expect(files.size).toBeGreaterThan(0);
            expect(fs.readFileSync(output.replace(/\.mp4$/, '.collected.mp4'))).toEqual(raw);
          }
          const beforeLate = fs.existsSync(output) ? fs.readFileSync(output) : undefined;
          child!.stdin.end('continue\n');
          await childExit;
          expect(childOutput).toMatch(/ENOTDIR|EEXIST/);
          expect(fs.existsSync(output) ? fs.readFileSync(output) : undefined).toEqual(beforeLate);
          expect(fs.readFileSync(path.join(sentinel, 'sentinel'), 'utf8')).toBe('unchanged');
          const facts = await withoutCommandExecutorOverride(() =>
            readProcessIdentityFacts(childIdentity!.pid),
          );
          expect(facts.startTime !== childIdentity!.startTime || facts.zombie).toBe(true);
        },
      );
    } finally {
      finalizerClock.expired = false;
      releaseHelper?.();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.stdin.end('continue\n');
        await childExit;
      }
      selection.mockRestore();
      await runtime?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'canceling a stop leaves the host-owned validator compile running',
  async () => {
    const root = mkdtempForTestSync('daemon-finalizer-warm-validator-');
    const sentinel = path.join(root, 'sentinel');
    fs.mkdirSync(sentinel);
    fs.writeFileSync(path.join(sentinel, 'sentinel'), 'unchanged');
    const host = recordingDaemonHost({
      cwd: root,
      env: { ...process.env, AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache') },
    });
    const outputPath = path.join(root, 'output.mp4');
    fs.writeFileSync(outputPath, Buffer.from('0000000c6674797069736f6d000000086d6f6f76', 'hex'));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releaseCompile = new Promise<void>((resolve) => {
      release = resolve;
    });
    let compilerSignal: AbortSignal | undefined;
    const preparation = createVideoValidatorPreparation(host);
    const finalizer = createScreenRecordingFinalizer(host, preparation);
    try {
      await withCommandExecutorOverride(
        async (command, args, options) => {
          if (command !== 'xcrun')
            return await withoutCommandExecutorOverride(() => runCmd(command, args, options));
          compilerSignal = options.signal;
          entered();
          await releaseCompile;
          fs.writeFileSync(args[args.indexOf('-o') + 1]!, 'compiled validator', { mode: 0o755 });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        async () => {
          await finalizer.prepare({ container: 'mp4' });
          await started;
          const stop = new AbortController();
          const finishing = finalizer.complete(
            { outputPath, showTouches: false, gestureEvents: [], targetLabel: 'recording' },
            stop.signal,
          );
          stop.abort();
          await expect(finishing).rejects.toMatchObject({
            details: { reason: 'request_canceled' },
          });
          expect(compilerSignal?.aborted).toBe(false);
          release();
          await expect(preparation.prepare()).resolves.toMatchObject({ kind: 'avfoundation' });
          expect(compilerSignal?.aborted).toBe(false);
          expect(fs.readFileSync(path.join(sentinel, 'sentinel'), 'utf8')).toBe('unchanged');
        },
      );
    } finally {
      release();
      await preparation.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
