import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createAndroidRuntimeModule } from '@agent-device/platform-android';
import { withAndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import type { VideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';
import { isScreenRecordingStartNotDispatched } from '@agent-device/contracts/screen-recording-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { createAndroidScreenRecordingTransport } from './platform-runtime-screen-recording-android-host.ts';
import './platform-runtime-android-adb-host.ts';

const validator: VideoValidatorPreparation = {
  prepare: async () => ({ kind: 'container' }),
  read: async () => ({ kind: 'container' }),
  close: async () => {},
};
const key = 'ccf89eb2e95b701cb64e560b9be91a9cdb00a1ea4817fdee5e9d58a4e3eba315';
const marker = `/sdcard/agent-device-recording-v2-admitted-${key}.json`;
const artifact = `/sdcard/agent-device-recording-v2-admitted-${key}-123.mp4`;
const androidRecordingDevice = {
  platform: 'android' as const,
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator' as const,
  target: 'mobile' as const,
  booted: true,
};
const recovery = {
  sessionId: 'one',
  fence: { token: 'fence-1', generation: 2 },
  claimToken: 'claim-token',
};
const armed = JSON.stringify({
  version: 3,
  resourceKind: 'screen-recording',
  fenceToken: recovery.fence.token,
  claimToken: recovery.claimToken,
  fenceGeneration: recovery.fence.generation,
  sessionId: recovery.sessionId,
  deviceId: androidRecordingDevice.id,
  startedAt: 1,
  outputPath: '/tmp/capture.mp4',
  scope: 'device',
  showTouches: true,
  recordOnlySession: false,
  chunks: [],
  pendingRemotePath: artifact,
  transportMode: 'transport-composed',
  launchDisposition: 'armed',
});
const admitted = JSON.stringify({ ...JSON.parse(armed), launchDisposition: 'admitted' });

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function rig(
  run: (rig: {
    transport: Awaited<ReturnType<typeof createAndroidScreenRecordingTransport>>;
    recover: () => Promise<'confirmed-no-effect' | 'retained'>;
    startOther: () => Promise<unknown>;
    dispatch: () => ReturnType<typeof launch>;
    markerFile: string;
    ledger: string;
    gate: string;
    checkpointReady: string;
    checkpointGate: string;
    legacyMarker: string;
    legacyArtifact: string;
    admissionDir: string;
    otherPrepared: () => number;
    legacyWrite: (contents: string) => Promise<void>;
    pauseDispatch: ReturnType<typeof barrier>;
    seenDispatch: ReturnType<typeof barrier>;
    options: {
      pauseBeforeDispatch: boolean;
      pauseBeforeWriter: boolean;
      replaceOnArtifactProbe?: string;
      casFailure: boolean;
      pauseCheckpoint: boolean;
    };
    signals: string[];
  }) => Promise<void>,
) {
  const root = mkdtempForTestSync('android-marker-protocol-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  const claimsDir = path.join(root, 'claims');
  mkdirSync(claimsDir);
  const claimsSentinel = path.join(claimsDir, 'sentinel');
  const otherClaimsDir = path.join(root, 'other-claims');
  mkdirSync(otherClaimsDir);
  const otherSentinel = path.join(otherClaimsDir, 'sentinel');
  writeFileSync(otherSentinel, 'untouched');
  writeFileSync(claimsSentinel, 'untouched');
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const sdcard = path.join(root, 'sdcard');
  const local = path.join(root, 'local');
  const bin = path.join(root, 'bin');
  mkdirSync(sdcard);
  mkdirSync(local);
  mkdirSync(bin);
  const ledger = path.join(root, 'writer');
  const gate = path.join(root, 'resume');
  const hold = path.join(root, 'hold');
  const checkpointReady = path.join(root, 'checkpoint-ready');
  const checkpointGate = path.join(root, 'checkpoint-gate');
  const legacyMarker = path.join(sdcard, 'agent-device-recording-active.json');
  const legacyArtifact = path.join(sdcard, 'agent-device-recording-123.mp4');
  const admissionDir = path.join(sdcard, 'agent-device-recording-v2-admitted-admission.lock');
  let prepareCount = 0;
  const ready = path.join(root, 'child-ready');
  const childPid = path.join(root, 'child-pid');
  writeFileSync(
    path.join(bin, 'screenrecord'),
    `#!/bin/sh
printf %s "$$" > '${childPid}'
if [ -e '${hold}' ]; then
  : > '${ready}'
  while [ ! -e '${gate}' ]; do sleep 0.02; done
fi
printf started > '${ledger}'
for arg do last="$arg"; done
printf artifact > "$last"
rm -f '${childPid}'
`,
    { mode: 0o755 },
  );
  const processes = new Set<ChildProcess>();
  const pendingLaunches = new Set<ReturnType<typeof launch>>();
  const pendingRecoveries = new Set<Promise<'confirmed-no-effect' | 'retained'>>();
  const signals: string[] = [];
  const pauseDispatch = barrier();
  const seenDispatch = barrier();
  const options = {
    pauseBeforeDispatch: false,
    pauseBeforeWriter: false,
    replaceOnArtifactProbe: undefined as string | undefined,
    casFailure: false,
    pauseCheckpoint: false,
  };
  const map = (value: string) =>
    value.replaceAll('/data/local/tmp', local).replaceAll('/sdcard', sdcard);
  const unmap = (value: string) =>
    value.replaceAll(local, '/data/local/tmp').replaceAll(sdcard, '/sdcard');
  const exec = async (args: readonly string[]) => {
    let command = args.slice(1).join(' ');
    if (command === 'ps -A -o pid=') return { stdout: '', stderr: '', exitCode: 0 };
    if (command.startsWith('kill ')) signals.push(command);
    if (command === `test -e ${artifact}` && options.replaceOnArtifactProbe !== undefined) {
      writeFileSync(path.join(sdcard, path.basename(marker)), options.replaceOnArtifactProbe);
      options.replaceOnArtifactProbe = undefined;
    }
    if (command.includes('screenrecord --bit-rate')) {
      seenDispatch.release();
      if (options.pauseBeforeDispatch) await pauseDispatch.promise;
      if (options.pauseBeforeWriter) writeFileSync(hold, 'hold');
    } else if (options.casFailure && command.includes('/expected')) {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    if (
      options.pauseCheckpoint &&
      command.includes('startNoEffectConfirmed') &&
      command.includes('cmp -s')
    ) {
      command = command.replace(
        '|| exit 73; printf %s ',
        `|| exit 73; : > '${checkpointReady}'; while [ ! -e '${checkpointGate}' ]; do sleep 0.02; done; printf %s `,
      );
    }
    command = map(command);
    return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', command], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        processes.add(child);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        child.once('error', reject);
        child.once('close', (exitCode) => {
          processes.delete(child);
          resolve({ stdout: unmap(stdout), stderr, exitCode: exitCode ?? 1 });
        });
      },
    );
  };
  try {
    await withAndroidAdbProvider({ exec }, { serial: androidRecordingDevice.id }, async () => {
      const transport = await createAndroidScreenRecordingTransport(
        androidRecordingDevice,
        validator,
      );
      const host = {
        hostEnvironment: createTestHostEnvironment({
          env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir },
        }),
        androidTools: { probeClipboardShellSupport: async () => 'unsupported' },
        processTransports: { resolve: async () => ({}) },
        localInteractors: {
          resolve: async () => {
            throw new Error('unexpected interactor');
          },
        },
        audioProbe: { hostCapture: {} },
        screenRecording: {
          android: { resolve: async () => transport },
          outputs: { prepare: async () => {} },
          finalize: { prepare: async () => {} },
        },
      } as unknown as PlatformRuntimeHost;
      const platform = await createAndroidRuntimeModule({
        bindAdbHost: async () => {},
      }).loadRuntime(host);
      const binding = await platform.bind({
        device: androidRecordingDevice,
        intent: { kind: 'ordinary' },
        scope: {
          signal: new AbortController().signal,
          diagnostics: { emit: () => {} },
          progress: { report: () => {} },
        },
      });
      const otherTransport = await createAndroidScreenRecordingTransport(
        androidRecordingDevice,
        validator,
      );
      const otherHost = {
        ...host,
        hostEnvironment: createTestHostEnvironment({
          env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: otherClaimsDir },
        }),
        screenRecording: {
          ...host.screenRecording,
          android: { resolve: async () => otherTransport },
          outputs: {
            ...host.screenRecording.outputs,
            prepare: async () => {
              prepareCount += 1;
            },
          },
        },
      } as PlatformRuntimeHost;
      const otherPlatform = await createAndroidRuntimeModule({
        bindAdbHost: async () => {},
      }).loadRuntime(otherHost);
      const otherBinding = await otherPlatform.bind({
        device: androidRecordingDevice,
        intent: { kind: 'ordinary' },
        scope: {
          signal: new AbortController().signal,
          diagnostics: { emit: () => {} },
          progress: { report: () => {} },
        },
      });
      try {
        await run({
          transport,
          recover: () => {
            const pending = binding.recoverIncompleteRecordingStart!(recovery);
            pendingRecoveries.add(pending);
            void pending.then(
              () => pendingRecoveries.delete(pending),
              () => pendingRecoveries.delete(pending),
            );
            return pending;
          },
          startOther: async () =>
            await otherBinding.operations.screenRecordingStart!({
              sessionId: 'other',
              claimToken: 'other-claim',
              fence: { token: 'other-fence', generation: 1 },
              outputPath: path.join(root, 'other.mp4'),
              scope: 'device',
              showTouches: false,
              hideTouchesRequested: false,
              recordOnlySession: false,
            }),
          dispatch: () => {
            const pending = launch(transport);
            pendingLaunches.add(pending);
            void pending.then(
              () => pendingLaunches.delete(pending),
              () => pendingLaunches.delete(pending),
            );
            return pending;
          },
          markerFile: path.join(sdcard, path.basename(marker)),
          ledger,
          gate,
          checkpointReady,
          checkpointGate,
          legacyMarker,
          legacyArtifact,
          admissionDir,
          otherPrepared: () => prepareCount,
          legacyWrite: async (contents) => {
            await new Promise<void>((resolve, reject) => {
              const child = spawn('/bin/sh', [
                '-c',
                'printf %s "$3" > "$1" && printf %s legacy-video > "$2"',
                'legacy',
                legacyMarker,
                legacyArtifact,
                contents,
              ]);
              processes.add(child);
              child.once('error', reject);
              child.once('close', (code) => {
                processes.delete(child);
                if (code === 0) resolve();
                else reject(new Error('legacy writer failed'));
              });
            });
          },
          pauseDispatch,
          seenDispatch,
          options,
          signals,
        });
      } finally {
        await otherBinding[Symbol.asyncDispose]();
        await binding[Symbol.asyncDispose]();
      }
    });
  } finally {
    pauseDispatch.release();
    writeFileSync(gate, 'resume');
    writeFileSync(checkpointGate, 'resume');
    try {
      await Promise.allSettled([...pendingLaunches, ...pendingRecoveries]);
      for (const child of processes) child.kill();
      await Promise.all(
        [...processes].map(
          (child) => new Promise<void>((resolve) => child.once('close', () => resolve())),
        ),
      );
      if (existsSync(childPid)) await vi.waitFor(() => expect(existsSync(childPid)).toBe(false));
      expect(readFileSync(claimsSentinel, 'utf8')).toBe('untouched');
      expect(readFileSync(otherSentinel, 'utf8')).toBe('untouched');
    } finally {
      if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
      else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
      rmSync(root, { recursive: true, force: true });
    }
  }
}

async function seed(transport: Awaited<ReturnType<typeof createAndroidScreenRecordingTransport>>) {
  expect(await transport.acquireAdmission(key)).toBe('acquired');
  expect(
    await transport.compareAndSetManifest({
      manifestPath: marker,
      expected: null,
      contents: armed,
    }),
  ).toBe('updated');
}

const launch = (transport: Awaited<ReturnType<typeof createAndroidScreenRecordingTransport>>) =>
  transport.start({
    remotePath: artifact,
    admission: { owner: key, manifestPath: marker, expected: armed, admitted },
  });

test('cancels a dispatched but not admitted launch on the device before it can create a writer', async () => {
  await rig(
    async ({
      transport,
      recover,
      dispatch,
      options,
      seenDispatch,
      pauseDispatch,
      ledger,
      markerFile,
      signals,
    }) => {
      await seed(transport);
      options.pauseBeforeDispatch = true;
      const old = dispatch().catch((error: unknown) => error);
      await seenDispatch.promise;
      expect(await recover()).toBe('confirmed-no-effect');
      expect(await recover()).toBe('confirmed-no-effect');
      expect(JSON.parse(readFileSync(markerFile, 'utf8')).launchDisposition).toBe('canceled');
      pauseDispatch.release();
      expect(await old).toBeInstanceOf(Error);
      expect(existsSync(ledger)).toBe(false);
      expect(signals).toEqual([]);
    },
  );
});

test('retains an admitted launch while its native command is paused before writer creation', async () => {
  await rig(
    async ({
      transport,
      recover,
      dispatch,
      options,
      seenDispatch,
      gate,
      ledger,
      markerFile,
      signals,
    }) => {
      await seed(transport);
      options.pauseBeforeWriter = true;
      const old = dispatch().catch((error: unknown) => error);
      await seenDispatch.promise;
      await vi.waitFor(() =>
        expect(existsSync(path.join(path.dirname(markerFile), '..', 'child-ready'))).toBe(true),
      );
      expect(JSON.parse(readFileSync(markerFile, 'utf8')).launchDisposition).toBe('admitted');
      expect(await recover()).toBe('retained');
      writeFileSync(gate, 'resume');
      await old;
      await vi.waitFor(() => expect(existsSync(ledger)).toBe(true));
      expect(signals).toEqual([]);
    },
  );
});

test('retains successor bytes and sends no signal when the marker changes before checkpoint', async () => {
  await rig(async ({ transport, recover, options, markerFile, signals }) => {
    await seed(transport);
    const successor = '{"successor":"unaltered bytes"}\n';
    options.replaceOnArtifactProbe = successor;
    expect(await recover()).toBe('retained');
    expect(readFileSync(markerFile, 'utf8')).toBe(successor);
    expect(signals).toEqual([]);
  });
});

test('retains the reservation when native conditional publication is unconfirmed', async () => {
  await rig(async ({ transport, recover, options }) => {
    await seed(transport);
    options.casFailure = true;
    expect(await recover()).toBe('retained');
    expect(await transport.readManifest(marker)).toEqual({ status: 'read', contents: armed });
  });
});

test('exclusive marker creation preserves an existing generation', async () => {
  await rig(async ({ transport }) => {
    await seed(transport);
    expect(
      await transport.compareAndSetManifest({
        manifestPath: marker,
        expected: null,
        contents: 'successor',
      }),
    ).toBe('mismatch');
    expect(await transport.readManifest(marker)).toEqual({ status: 'read', contents: armed });
  });
});

test('an old writer bypassing the new mutex cannot overwrite generation evidence or be overwritten by its checkpoint', async () => {
  await rig(
    async ({
      transport,
      recover,
      options,
      checkpointReady,
      checkpointGate,
      legacyMarker,
      legacyArtifact,
      legacyWrite,
      markerFile,
      signals,
    }) => {
      await seed(transport);
      options.pauseCheckpoint = true;
      const oldBytes = '{"legacy":"successor bytes"}\n';
      const settling = recover();
      await vi.waitFor(() => expect(existsSync(checkpointReady)).toBe(true));
      await legacyWrite(oldBytes);
      writeFileSync(checkpointGate, 'resume');
      expect(await settling).toBe('confirmed-no-effect');
      expect(readFileSync(legacyMarker, 'utf8')).toBe(oldBytes);
      expect(readFileSync(legacyArtifact, 'utf8')).toBe('legacy-video');
      expect(JSON.parse(readFileSync(markerFile, 'utf8')).launchDisposition).toBe('canceled');
      expect(signals).toEqual([]);
    },
  );
});

test('maps only version-two artifact paths to their generation-specific marker', async () => {
  await rig(async ({ transport }) => {
    expect(transport.manifestPathFor(artifact)).toBe(marker);
    expect(marker).not.toBe('/sdcard/agent-device-recording-active.json');
    expect(artifact).not.toBe('/sdcard/agent-device-recording-123.mp4');
    expect(() => transport.manifestPathFor('/sdcard/agent-device-recording-123.mp4')).toThrow();
  });
});

test('independent v2 hosts refuse a second generation while the first owns admission', async () => {
  await rig(
    async ({
      transport,
      startOther,
      dispatch,
      options,
      seenDispatch,
      markerFile,
      gate,
      signals,
      otherPrepared,
    }) => {
      await seed(transport);
      options.pauseBeforeWriter = true;
      const first = dispatch().catch((error: unknown) => error);
      await seenDispatch.promise;
      await vi.waitFor(() =>
        expect(JSON.parse(readFileSync(markerFile, 'utf8')).launchDisposition).toBe('admitted'),
      );
      const before = readFileSync(markerFile, 'utf8');
      const error = await startOther().catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'DEVICE_IN_USE',
        details: { reason: 'android_recording_admission_busy' },
      });
      expect(isScreenRecordingStartNotDispatched(error)).toBe(true);
      expect(otherPrepared()).toBe(0);
      expect(readFileSync(markerFile, 'utf8')).toBe(before);
      expect(signals).toEqual([]);
      writeFileSync(gate, 'resume');
      await first;
    },
  );
});

test('simultaneous v2 admission commands admit one generation and refuse foreign release', async () => {
  await rig(async ({ transport }) => {
    const other = 'b'.repeat(64);
    const results = await Promise.all([
      transport.acquireAdmission(key),
      transport.acquireAdmission(other),
    ]);
    expect([...results].sort()).toEqual(['acquired', 'busy']);
    const winner = results[0] === 'acquired' ? key : other;
    const loser = winner === key ? other : key;
    expect(
      await transport.releaseAdmission({ owner: loser, manifestPath: marker, expected: null }),
    ).toBe('not-owner');
    expect(await transport.acquireAdmission(loser)).toBe('busy');
    expect(
      await transport.releaseAdmission({ owner: winner, manifestPath: marker, expected: null }),
    ).toBe('released');
    expect(await transport.acquireAdmission(loser)).toBe('acquired');
  });
});

test('a launch without its exact device-wide owner cannot change the marker or start a writer', async () => {
  await rig(async ({ transport, markerFile, ledger }) => {
    await seed(transport);
    const before = readFileSync(markerFile, 'utf8');
    const error = await transport
      .start({
        remotePath: artifact,
        admission: { owner: 'b'.repeat(64), manifestPath: marker, expected: armed, admitted },
      })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(markerFile, 'utf8')).toBe(before);
    expect(existsSync(ledger)).toBe(false);
  });
});

test('retains an admission directory whose owner was never published', async () => {
  await rig(async ({ transport, admissionDir, markerFile }) => {
    mkdirSync(admissionDir);
    const evidence = path.join(admissionDir, 'unknown-owner-evidence');
    writeFileSync(evidence, 'untouched');
    expect(await transport.acquireAdmission(key)).toBe('busy');
    expect(
      await transport.releaseAdmission({ owner: key, manifestPath: marker, expected: null }),
    ).toBe('not-owner');
    expect(readFileSync(evidence, 'utf8')).toBe('untouched');
    expect(existsSync(markerFile)).toBe(false);
  });
});

test('does not release device admission when the generation marker was replaced', async () => {
  await rig(async ({ transport, markerFile }) => {
    await seed(transport);
    const successor = '{"successor":"preserved"}\n';
    writeFileSync(markerFile, successor);
    expect(
      await transport.releaseAdmission({ owner: key, manifestPath: marker, expected: armed }),
    ).toBe('not-owner');
    expect(readFileSync(markerFile, 'utf8')).toBe(successor);
    expect(await transport.acquireAdmission('b'.repeat(64))).toBe('busy');
  });
});
