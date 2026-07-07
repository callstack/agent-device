import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { withMockedAdb } from '../../../src/__tests__/test-utils/mocked-binaries.ts';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import {
  assertCommandCall,
  assertRecordingStarted,
  assertRecordingStopped,
  assertRpcError,
  assertRpcOk,
} from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import {
  restoreEnv,
  createProviderScenarioHarness,
  likelyPlayableMp4Container,
  withProviderScenarioTempDir,
} from './harness.ts';

type ProviderScenarioDaemon = Awaited<ReturnType<typeof createProviderScenarioHarness>>;
type ProviderScenarioRpcResult = Awaited<ReturnType<ProviderScenarioDaemon['callCommand']>>;
type PullCall = { remotePath: string; localPath: string };

test('Provider-backed integration Android recording flow uses scripted ADB provider pull capability', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-',
    runAndroidRecordingFlowScenario,
  );
});

test('Provider-backed integration Android record stop recovers missing daemon recording state from durable manifest', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-recovery-',
    runAndroidManifestRecoveryScenario,
  );
});

test('Provider-backed integration Android record stop recovers cwd-scoped durable manifest', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-scoped-recovery-',
    runAndroidScopedManifestRecoveryScenario,
  );
});

test('Provider-backed integration Android record stop gives cwd retry hint for scoped owner mismatch', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-scoped-owner-mismatch-',
    runAndroidScopedOwnerMismatchHintScenario,
  );
});

test('Provider-backed integration Android record stop recovers opened cwd-scoped recording after daemon state loss', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-open-scoped-recovery-',
    runAndroidOpenScopedRecordingRecoveryScenario,
  );
});

test('Provider-backed integration Android record stop does not recover ownerless live screenrecord', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-ownerless-recovery-',
    runAndroidOwnerlessRecordingRecoveryScenario,
  );
});

test('Provider-backed integration Android record stop refuses another session durable manifest', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-wrong-session-',
    async (tmpDir) => {
      const adbCalls: string[][] = [];
      const pullCalls: Array<{ remotePath: string; localPath: string }> = [];
      const remotePath = '/sdcard/agent-device-recording-223456789.mp4';
      const manifest = buildAndroidRecordingManifest({
        outPath: path.join(tmpDir, 'other-session.mp4'),
        remotePath,
        sessionName: 'checkout',
      });
      const adbProvider: AndroidAdbProvider = {
        exec: async (args) => {
          adbCalls.push([...args]);
          if (args.join(' ') === 'shell cat /sdcard/agent-device-recording-active.json') {
            return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
          }
          if (args.join(' ') === 'shell ps -o pid=,args= -p 4321') {
            return {
              stdout: `4321 screenrecord --bit-rate 8000000 ${remotePath}\n`,
              stderr: '',
              exitCode: 0,
            };
          }
          return androidAdbResult(args);
        },
        pull: async (from, to) => {
          pullCalls.push({ remotePath: from, localPath: to });
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const daemon = await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });

      try {
        const recordStop = await daemon.callCommand('record', ['stop'], {
          platform: 'android',
          serial: PROVIDER_SCENARIO_ANDROID.id,
        });

        assertRpcError(recordStop, 'INVALID_ARGS', /belongs to session "checkout"/);
        assert.equal(
          adbCalls.some((args) => args.join(' ') === 'shell kill -2 4321'),
          false,
        );
        assert.equal(pullCalls.length, 0);
      } finally {
        await daemon.close();
      }
    },
  );
});

test('Provider-backed integration Android record stop ignores manifest host output paths', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-host-path-',
    runAndroidManifestHostPathScenario,
  );
});

test('Provider-backed integration Android record stop refuses another session uncertain manifest', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-wrong-session-uncertain-',
    runAndroidOtherSessionUncertainManifestScenario,
  );
});

test('Provider-backed integration Android record stop refuses ambiguous durable manifests', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-ambiguous-',
    runAndroidAmbiguousManifestRecoveryScenario,
  );
});

test('Provider-backed integration Android record stop cleans stale durable manifest', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-stale-manifest-',
    async (tmpDir) => {
      const adbCalls: string[][] = [];
      const execOptions: Array<{ command: string; timeoutMs?: number }> = [];
      const remotePath = '/sdcard/agent-device-recording-423456789.mp4';
      const manifest = buildAndroidRecordingManifest({
        outPath: path.join(tmpDir, 'stale.mp4'),
        remotePath,
        sessionName: 'default',
      });
      const adbProvider: AndroidAdbProvider = {
        exec: async (args, options) => {
          adbCalls.push([...args]);
          execOptions.push({ command: args.join(' '), timeoutMs: options?.timeoutMs });
          const command = args.join(' ');
          if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
            return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
          }
          if (command === 'shell ps -o pid=,args= -p 4321') {
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (command === `shell stat -c %s ${remotePath}`) {
            return { stdout: '', stderr: '', exitCode: 1 };
          }
          return androidAdbResult(args);
        },
      };
      const daemon = await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });

      try {
        const recordStop = await daemon.callCommand('record', ['stop'], {
          platform: 'android',
          serial: PROVIDER_SCENARIO_ANDROID.id,
        });

        assertRpcError(recordStop, 'INVALID_ARGS', /no active recording/);
        assertCommandCall(adbCalls, [
          'shell',
          'rm',
          '-f',
          '/sdcard/agent-device-recording-active.json',
        ]);
        assert.equal(
          execOptions.some((entry) => entry.command === 'shell ps -A -o pid=,args='),
          false,
        );
      } finally {
        await daemon.close();
      }
    },
  );
});

test('Provider-backed integration Android record stop cleans stale manifest when pid is reused by another process', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-pid-reuse-',
    runAndroidPidReuseManifestScenario,
  );
});

test('Provider-backed integration Android record stop keeps mismatched device manifest', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-device-mismatch-',
    runAndroidDeviceMismatchManifestScenario,
  );
});

test('Provider-backed integration Android record stop recovers manifest chunks after daemon state loss', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-chunk-recovery-',
    runAndroidManifestChunkRecoveryScenario,
  );
}, 15_000);

test('Provider-backed integration Android record stop recovers pending manifest after daemon state loss', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-pending-recovery-',
    runAndroidPendingManifestRecoveryScenario,
  );
});

test('Provider-backed integration Android record stop recovers finished pending manifest after process exit', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-pending-finished-',
    runAndroidPendingFinishedManifestRecoveryScenario,
  );
});

test('Provider-backed integration Android record stop recovers rotating manifest after daemon state loss', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-rotating-recovery-',
    runAndroidRotatingManifestRecoveryScenario,
  );
}, 15_000);

test('Provider-backed integration Android record stop recovers while another device is recording', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-cross-device-recovery-',
    runAndroidCrossDeviceRecordingRecoveryScenario,
  );
});

test('Provider-backed integration Android record stop keeps valid metadata on uncertain liveness probe', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-uncertain-metadata-',
    runAndroidUncertainMetadataScenario,
  );
});

test('Provider-backed integration Android record stop cleans corrupt recovery metadata', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-corrupt-metadata-',
    runAndroidCorruptMetadataScenario,
  );
});

test('Provider-backed integration Android record start without a session scopes default-device providers', async () => {
  await withMockedAdb(
    'agent-device-provider-scenario-android-sessionless-record-',
    runAndroidSessionlessRecordingWithMockedAdb,
  );
});

async function runAndroidRecordingFlowScenario(tmpDir: string): Promise<void> {
  const context = await createAndroidRecordingFlowContext(tmpDir);
  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      await exerciseAndroidRecordingFlow(context);
      assertAndroidRecordingFlow(context);
    } finally {
      await context.daemon.close();
    }
  });
}

async function runAndroidManifestRecoveryScenario(tmpDir: string): Promise<void> {
  const remotePath = '/sdcard/agent-device-recording-123456789.mp4';
  const recordingPath = path.join(tmpDir, 'recovered-recording.mp4');
  const context = await createAndroidSingleManifestRecoveryContext({
    outPath: recordingPath,
    remotePath,
    sessionName: 'default',
  });

  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      const recordStop = await stopAndroidRecording(context.daemon, recordingPath);
      assertAndroidManifestRecovery(recordStop, { ...context, recordingPath, remotePath });
    } finally {
      await context.daemon.close();
    }
  });
}

async function runAndroidManifestHostPathScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const remotePath = '/sdcard/agent-device-recording-823456789.mp4';
  const requestedPath = path.join(tmpDir, 'requested.mp4');
  const manifestPath = path.join(tmpDir, 'manifest-controlled.mp4');
  const manifest = buildAndroidRecordingManifest({
    outPath: manifestPath,
    remotePath,
    sessionName: 'default',
    chunks: [{ index: 1, path: manifestPath, remotePath }],
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createAndroidManifestProvider({ adbCalls, pullCalls, manifests: [manifest] }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await stopAndroidRecording(daemon, requestedPath);
    const data = assertRpcOk<{ recording?: unknown; outPath?: unknown }>(recordStop);
    assert.equal(data.recording, 'stopped');
    assert.equal(data.outPath, requestedPath);
    assert.deepEqual(pullCalls, [{ remotePath, localPath: requestedPath }]);
    assert.equal(fs.existsSync(requestedPath), true);
    assert.equal(fs.existsSync(manifestPath), false);
  } finally {
    await daemon.close();
  }
}

async function runAndroidScopedManifestRecoveryScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const remotePath = '/sdcard/agent-device-recording-923456123.mp4';
  const recordingPath = path.join(tmpDir, 'scoped-recovered-recording.mp4');
  const scopeRoot = path.join(tmpDir, 'worktree');
  fs.mkdirSync(path.join(scopeRoot, '.git'), { recursive: true });
  const scopeId = hashScopeRoot(fs.realpathSync.native(scopeRoot));
  const manifest = buildAndroidRecordingManifest({
    outPath: recordingPath,
    remotePath,
    sessionName: `cwd:${scopeId}:default`,
    sessionScope: { kind: 'cwd', id: scopeId },
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createAndroidManifestProvider({ adbCalls, pullCalls, manifests: [manifest] }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await daemon.callCommand(
      'record',
      ['stop', recordingPath],
      {
        platform: 'android',
        serial: PROVIDER_SCENARIO_ANDROID.id,
      },
      { meta: { cwd: scopeRoot } },
    );
    const data = assertRpcOk<{ recording?: unknown; outPath?: unknown }>(recordStop);
    assert.equal(data.recording, 'stopped');
    assert.equal(data.outPath, recordingPath);
    assert.deepEqual(pullCalls, [{ remotePath, localPath: recordingPath }]);
  } finally {
    await daemon.close();
  }
}

async function runAndroidScopedOwnerMismatchHintScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const remotePath = '/sdcard/agent-device-recording-923456124.mp4';
  const recordingPath = path.join(tmpDir, 'scoped-owner-mismatch.mp4');
  const scopeRoot = path.join(tmpDir, 'worktree');
  fs.mkdirSync(path.join(scopeRoot, '.git'), { recursive: true });
  const scopeId = hashScopeRoot(fs.realpathSync.native(scopeRoot));
  const effectiveSessionName = `cwd:${scopeId}:default`;
  const manifest = buildAndroidRecordingManifest({
    outPath: recordingPath,
    remotePath,
    sessionName: effectiveSessionName,
    sessionScope: { kind: 'cwd', id: scopeId },
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createAndroidManifestProvider({ adbCalls, pullCalls, manifests: [manifest] }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await daemon.callCommand('record', ['stop', recordingPath], {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
      session: effectiveSessionName,
    });
    assertRpcError(
      recordStop,
      'INVALID_ARGS',
      /retry record stop from the original working directory without --session/,
    );
    assert.equal(
      adbCalls.some((args) => args.join(' ') === 'shell kill -2 4321'),
      false,
    );
    assert.equal(pullCalls.length, 0);
  } finally {
    await daemon.close();
  }
}

async function runAndroidOpenScopedRecordingRecoveryScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const scopeRoot = path.join(tmpDir, 'worktree');
  const recordingPath = path.join(tmpDir, 'opened-scoped-recovered.mp4');
  fs.mkdirSync(path.join(scopeRoot, '.git'), { recursive: true });
  const scopeId = hashScopeRoot(fs.realpathSync.native(scopeRoot));
  const provider = createStatefulAndroidRecordingProvider({ adbCalls, pullCalls });
  const createDaemon = async () =>
    await createProviderScenarioHarness({
      androidAdbProvider: () => provider,
      deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
    });
  const firstDaemon = await createDaemon();
  try {
    const open = await firstDaemon.callCommand(
      'open',
      ['settings'],
      {
        platform: 'android',
        serial: PROVIDER_SCENARIO_ANDROID.id,
      },
      { meta: { cwd: scopeRoot } },
    );
    assertRpcOk(open);
    const recordStart = await firstDaemon.callCommand(
      'record',
      ['start', recordingPath],
      {
        platform: 'android',
        serial: PROVIDER_SCENARIO_ANDROID.id,
      },
      { meta: { cwd: scopeRoot } },
    );
    assertRecordingStarted(recordStart, { showTouches: true });
    assert.equal(provider.manifest?.sessionName, `cwd:${scopeId}:default`);
    assert.deepEqual(provider.manifest?.sessionScope, { kind: 'cwd', id: scopeId });
  } finally {
    await firstDaemon.close();
  }

  const secondDaemon = await createDaemon();
  try {
    const recordStop = await secondDaemon.callCommand(
      'record',
      ['stop', recordingPath],
      {
        platform: 'android',
        serial: PROVIDER_SCENARIO_ANDROID.id,
      },
      { meta: { cwd: scopeRoot } },
    );
    const data = assertRpcOk<{ recording?: unknown; outPath?: unknown }>(recordStop);
    assert.equal(data.recording, 'stopped');
    assert.equal(data.outPath, recordingPath);
    assert.equal(fs.existsSync(recordingPath), true);
    assert.equal(pullCalls.length, 1);
  } finally {
    await secondDaemon.close();
  }
}

async function runAndroidAmbiguousManifestRecoveryScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const firstRemotePath = '/sdcard/agent-device-recording-323456789.mp4';
  const secondRemotePath = '/data/local/tmp/agent-device-recording-323456790.mp4';
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createAndroidManifestProvider({
        adbCalls,
        manifests: [
          buildAndroidRecordingManifest({
            outPath: path.join(tmpDir, 'first.mp4'),
            remotePath: firstRemotePath,
            sessionName: 'default',
          }),
          buildAndroidRecordingManifest({
            outPath: path.join(tmpDir, 'second.mp4'),
            remotePath: secondRemotePath,
            sessionName: 'default',
            remotePid: '9876',
          }),
        ],
      }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await stopAndroidRecording(daemon);
    assertRpcError(recordStop, 'INVALID_ARGS', /multiple active Android recording manifests/);
    assert.equal(
      adbCalls.some((args) => args.join(' ').startsWith('shell kill -2')),
      false,
    );
  } finally {
    await daemon.close();
  }
}

async function runAndroidOtherSessionUncertainManifestScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const remotePath = '/sdcard/agent-device-recording-723456789.mp4';
  const manifest = buildAndroidRecordingManifest({
    outPath: path.join(tmpDir, 'other-session-uncertain.mp4'),
    remotePath,
    sessionName: 'checkout',
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => ({
      exec: async (args) => {
        adbCalls.push([...args]);
        const command = args.join(' ');
        if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
          return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
        }
        if (command === 'shell cat /data/local/tmp/agent-device-recording-active.json') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (command === 'shell ps -o pid=,args= -p 4321') {
          return { stdout: '', stderr: 'transient ps failure', exitCode: 1 };
        }
        if (command === 'shell ps -A -o pid=,args=') {
          return {
            stdout: `4321 screenrecord --bit-rate 8000000 ${remotePath}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        return androidAdbResult(args);
      },
      pull: async (from, to) => {
        pullCalls.push({ remotePath: from, localPath: to });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await daemon.callCommand('record', ['stop'], {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
    });
    assertRpcError(recordStop, 'INVALID_ARGS', /belongs to session "checkout"/);
    assert.equal(
      adbCalls.some((args) => args.join(' ') === 'shell ps -A -o pid=,args='),
      false,
    );
    assert.equal(
      adbCalls.some((args) => args.join(' ') === 'shell kill -2 4321'),
      false,
    );
    assert.equal(
      adbCalls.some(
        (args) => args.join(' ') === 'shell rm -f /sdcard/agent-device-recording-active.json',
      ),
      false,
    );
    assert.equal(pullCalls.length, 0);
  } finally {
    await daemon.close();
  }
}

async function runAndroidManifestChunkRecoveryScenario(tmpDir: string): Promise<void> {
  const firstRemotePath = '/sdcard/agent-device-recording-523456789.mp4';
  const secondRemotePath = '/sdcard/agent-device-recording-523456790.mp4';
  const firstLocalPath = path.join(tmpDir, 'chunked.mp4');
  const secondLocalPath = path.join(tmpDir, 'chunked.part-002.mp4');
  const context = await createAndroidSingleManifestRecoveryContext({
    outPath: firstLocalPath,
    remotePath: secondRemotePath,
    sessionName: 'default',
    startedAt: 523456789,
    chunks: [
      { index: 1, path: firstLocalPath, remotePath: firstRemotePath },
      { index: 2, path: secondLocalPath, remotePath: secondRemotePath },
    ],
  });

  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      const recordStop = await stopAndroidRecording(context.daemon, firstLocalPath);
      assertAndroidManifestChunkRecovery(recordStop, {
        ...context,
        firstLocalPath,
        firstRemotePath,
        secondLocalPath,
        secondRemotePath,
      });
    } finally {
      await context.daemon.close();
    }
  });
}

async function runAndroidPendingManifestRecoveryScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const remotePath = '/sdcard/agent-device-recording-623456789.mp4';
  const recordingPath = path.join(tmpDir, 'pending-recovered.mp4');
  const manifest = buildAndroidRecordingManifest({
    outPath: recordingPath,
    remotePath,
    sessionName: 'default',
    status: 'pending',
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createAndroidManifestProvider({ adbCalls, pullCalls, manifests: [manifest] }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await stopAndroidRecording(daemon, recordingPath);
    const data = assertRpcOk<{ recording?: unknown; outPath?: unknown; warning?: unknown }>(
      recordStop,
    );
    assert.equal(data.recording, 'stopped');
    assert.equal(data.outPath, recordingPath);
    assert.match(String(data.warning), /durable device manifest/);
    assertCommandCall(adbCalls, ['shell', 'ps', '-A', '-o', 'pid=,args=']);
    assertCommandCall(adbCalls, ['shell', 'kill', '-2', '4321']);
    assert.deepEqual(pullCalls, [{ remotePath, localPath: recordingPath }]);
  } finally {
    await daemon.close();
  }
}

async function runAndroidPendingFinishedManifestRecoveryScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const remotePath = '/sdcard/agent-device-recording-624000001.mp4';
  const recordingPath = path.join(tmpDir, 'pending-finished-recovered.mp4');
  const manifest = buildAndroidRecordingManifest({
    outPath: recordingPath,
    remotePath,
    sessionName: 'default',
    status: 'pending',
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => ({
      exec: async (args) => {
        adbCalls.push([...args]);
        const command = args.join(' ');
        if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
          return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
        }
        if (command === 'shell cat /data/local/tmp/agent-device-recording-active.json') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        // The pending screenrecord process already exited: the full process scan finds no
        // match, but the on-device file still exists (default stat returns a non-zero size).
        if (command === 'shell ps -A -o pid=,args=') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return androidAdbResult(args);
      },
      pull: async (from, to) => {
        pullCalls.push({ remotePath: from, localPath: to });
        writePlayableMp4(to);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await stopAndroidRecording(daemon, recordingPath);
    const data = assertRpcOk<{ recording?: unknown; outPath?: unknown; warning?: unknown }>(
      recordStop,
    );
    assert.equal(data.recording, 'stopped');
    assert.equal(data.outPath, recordingPath);
    assert.match(String(data.warning), /no longer running/);
    // A pending manifest never recorded a pid and the process is confirmed gone, so stop
    // sends no signal — it just pulls the completed file instead of discarding it.
    assert.equal(
      adbCalls.some((args) => args.join(' ').startsWith('shell kill -2')),
      false,
    );
    assert.deepEqual(pullCalls, [{ remotePath, localPath: recordingPath }]);
    assert.equal(fs.existsSync(recordingPath), true);
  } finally {
    await daemon.close();
  }
}

async function runAndroidRotatingManifestRecoveryScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const firstRemotePath = '/sdcard/agent-device-recording-723456789.mp4';
  const secondRemotePath = '/sdcard/agent-device-recording-723456790.mp4';
  const firstLocalPath = path.join(tmpDir, 'rotating.mp4');
  const secondLocalPath = path.join(tmpDir, 'rotating.part-002.mp4');
  const manifest = buildAndroidRecordingManifest({
    outPath: firstLocalPath,
    remotePath: firstRemotePath,
    sessionName: 'default',
    status: 'rotating',
    pendingRemotePath: secondRemotePath,
    chunks: [
      { index: 1, path: firstLocalPath, remotePath: firstRemotePath },
      { index: 2, path: secondLocalPath, remotePath: secondRemotePath },
    ],
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createAndroidManifestProvider({ adbCalls, pullCalls, manifests: [manifest] }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await stopAndroidRecording(daemon, firstLocalPath);
    const data = assertRpcOk<{
      recording?: unknown;
      warning?: unknown;
      chunks?: Array<{ index?: unknown; path?: unknown }>;
    }>(recordStop);
    assert.equal(data.recording, 'stopped');
    assert.match(String(data.warning), /interrupted chunk rotation/);
    assert.deepEqual(data.chunks, [
      { index: 1, path: firstLocalPath },
      { index: 2, path: secondLocalPath },
    ]);
    assertCommandCall(adbCalls, ['shell', 'ps', '-A', '-o', 'pid=,args=']);
    assertCommandCall(adbCalls, ['shell', 'kill', '-2', '4322']);
    assert.deepEqual(pullCalls, [
      { remotePath: firstRemotePath, localPath: firstLocalPath },
      { remotePath: secondRemotePath, localPath: secondLocalPath },
    ]);
  } finally {
    await daemon.close();
  }
}

async function createAndroidSingleManifestRecoveryContext(options: {
  outPath: string;
  remotePath: string;
  sessionName: string;
  startedAt?: number;
  chunks?: Array<{ index: number; path: string; remotePath: string }>;
}): Promise<{
  adbCalls: string[][];
  pullCalls: PullCall[];
  daemon: ProviderScenarioDaemon;
}> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const manifest = buildAndroidRecordingManifest(options);
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createAndroidManifestProvider({ adbCalls, pullCalls, manifests: [manifest] }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  return { adbCalls, pullCalls, daemon };
}

async function stopAndroidRecording(
  daemon: ProviderScenarioDaemon,
  outPath?: string,
): Promise<ProviderScenarioRpcResult> {
  return await daemon.callCommand('record', outPath ? ['stop', outPath] : ['stop'], {
    platform: 'android',
    serial: PROVIDER_SCENARIO_ANDROID.id,
  });
}

function assertAndroidManifestRecovery(
  recordStop: ProviderScenarioRpcResult,
  context: {
    adbCalls: string[][];
    pullCalls: PullCall[];
    recordingPath: string;
    remotePath: string;
  },
): void {
  const data = assertRpcOk<{
    recording?: unknown;
    outPath?: unknown;
    warning?: unknown;
    overlayWarning?: unknown;
  }>(recordStop);
  assert.equal(data.recording, 'stopped');
  assert.equal(data.outPath, context.recordingPath);
  assert.match(String(data.warning), /durable device manifest/);
  assert.match(String(data.overlayWarning), /gesture telemetry/);
  assert.equal(fs.existsSync(context.recordingPath), true);
  assertAndroidManifestRecoveryCommands(context);
}

function assertAndroidManifestRecoveryCommands(context: {
  adbCalls: string[][];
  pullCalls: PullCall[];
  recordingPath: string;
  remotePath: string;
}): void {
  assertCommandCall(context.adbCalls, [
    'shell',
    'cat',
    '/sdcard/agent-device-recording-active.json',
  ]);
  assertCommandCall(context.adbCalls, ['shell', 'ps', '-o', 'pid=,args=', '-p', '4321']);
  assert.equal(
    context.adbCalls.some((args) => args.join(' ') === 'shell ps -A -o pid=,args='),
    false,
  );
  assertCommandCall(context.adbCalls, ['shell', 'kill', '-2', '4321']);
  assert.equal(context.pullCalls.length, 1);
  assert.deepEqual(context.pullCalls[0], {
    remotePath: context.remotePath,
    localPath: context.recordingPath,
  });
  assertCommandCall(context.adbCalls, ['shell', 'rm', '-f', context.remotePath]);
  assertCommandCall(context.adbCalls, [
    'shell',
    'rm',
    '-f',
    '/sdcard/agent-device-recording-active.json',
  ]);
}

function assertAndroidManifestChunkRecovery(
  recordStop: ProviderScenarioRpcResult,
  context: {
    adbCalls: string[][];
    pullCalls: PullCall[];
    firstLocalPath: string;
    firstRemotePath: string;
    secondLocalPath: string;
    secondRemotePath: string;
  },
): void {
  const data = assertRpcOk<{
    recording?: unknown;
    chunks?: Array<{ index?: unknown; path?: unknown }>;
  }>(recordStop);
  assert.equal(data.recording, 'stopped');
  assert.deepEqual(data.chunks, [
    { index: 1, path: context.firstLocalPath },
    { index: 2, path: context.secondLocalPath },
  ]);
  assert.deepEqual(context.pullCalls, [
    { remotePath: context.firstRemotePath, localPath: context.firstLocalPath },
    { remotePath: context.secondRemotePath, localPath: context.secondLocalPath },
  ]);
  assertCommandCall(context.adbCalls, ['shell', 'kill', '-2', '4321']);
  assertCommandCall(context.adbCalls, ['shell', 'rm', '-f', context.firstRemotePath]);
  assertCommandCall(context.adbCalls, ['shell', 'rm', '-f', context.secondRemotePath]);
}

async function createAndroidRecordingFlowContext(tmpDir: string): Promise<{
  recordingPath: string;
  adbCalls: string[][];
  pullCalls: PullCall[];
  daemon: ProviderScenarioDaemon;
}> {
  const recordingPath = path.join(tmpDir, 'recording.mp4');
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => createPullingAndroidProvider({ adbCalls, pullCalls }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  return { recordingPath, adbCalls, pullCalls, daemon };
}

async function exerciseAndroidRecordingFlow(context: {
  recordingPath: string;
  daemon: ProviderScenarioDaemon;
}): Promise<void> {
  const open = await context.daemon.callCommand('open', ['settings'], {
    platform: 'android',
    serial: PROVIDER_SCENARIO_ANDROID.id,
  });
  assertRpcOk(open);

  const recordStart = await context.daemon.callCommand('record', ['start', context.recordingPath], {
    hideTouches: true,
    screenshotMaxSize: 1344,
    quality: 'high',
  });
  assertRecordingStarted(recordStart, { showTouches: false });

  const recordStop = await context.daemon.callCommand('record', ['stop']);
  assertRecordingStopped(recordStop, context.recordingPath, { showTouches: false });
}

function assertAndroidRecordingFlow(context: {
  recordingPath: string;
  adbCalls: string[][];
  pullCalls: PullCall[];
}): void {
  const { recordingPath, adbCalls, pullCalls } = context;
  assert.equal(fs.existsSync(recordingPath), true);
  assertCommandCall(adbCalls, ['shell', 'wm', 'size']);
  assert.ok(adbCalls.some((args) => isAndroidHighQualityScreenrecordStartCommand(args.join(' '))));
  assertCommandCall(adbCalls, ['shell', 'kill', '-2', '4321']);
  assert.equal(pullCalls.length, 1);
  assert.match(pullCalls[0]?.remotePath ?? '', /^\/sdcard\/agent-device-recording-\d+\.mp4$/);
  assert.equal(pullCalls[0]?.localPath, recordingPath);
  assert.ok(adbCalls.some((args) => args[0] === 'shell' && args[1] === 'rm'));
  assert.equal(
    adbCalls.some((args) => args[0] === 'pull'),
    false,
  );
}

async function runAndroidCrossDeviceRecordingRecoveryScenario(tmpDir: string): Promise<void> {
  const otherAndroid = { ...PROVIDER_SCENARIO_ANDROID, id: 'emulator-5556', name: 'Pixel 8 B' };
  const remotePath = '/sdcard/agent-device-recording-123456789.mp4';
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const recoveredPath = path.join(tmpDir, 'recovered-cross-device.mp4');
  const manifest = buildAndroidRecordingManifest({
    outPath: recoveredPath,
    remotePath,
    sessionName: 'default',
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createAndroidManifestProvider({
        adbCalls,
        pullCalls,
        manifests: [manifest],
      }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID, otherAndroid],
  });

  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      seedAndroidSession(daemon, 'default', PROVIDER_SCENARIO_ANDROID);
      const busyRecordingPath = path.join(tmpDir, 'busy-recording.mp4');
      const busyRemotePath = '/sdcard/agent-device-recording-623456789.mp4';
      daemon.setSession('busy', {
        name: 'busy',
        device: otherAndroid,
        createdAt: Date.now(),
        actions: [],
        recording: {
          platform: 'android',
          recordingId: 'busy-recording',
          remotePath: busyRemotePath,
          remotePid: '6789',
          remoteStartedAt: 623456789,
          chunks: [{ index: 1, path: busyRecordingPath, remotePath: busyRemotePath }],
          outPath: busyRecordingPath,
          startedAt: 623456789,
          showTouches: true,
          gestureEvents: [],
        },
      });
      const recordStop = await daemon.callCommand(
        'record',
        ['stop', recoveredPath],
        {},
        { session: 'default' },
      );
      const data = assertRpcOk<{ recording?: unknown; outPath?: unknown }>(recordStop);
      assert.equal(data.recording, 'stopped');
      assert.equal(data.outPath, recoveredPath);
      assert.equal(daemon.session('busy')?.recording !== undefined, true);
      assert.equal(
        adbCalls.some((args) => args.join(' ') === 'shell ps -A -o pid=,args='),
        false,
      );
      assert.equal(pullCalls.length, 1);
    } finally {
      await daemon.close();
    }
  });
}

async function runAndroidOwnerlessRecordingRecoveryScenario(tmpDir: string): Promise<void> {
  const context = await createAndroidRecordingRecoveryContext();
  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      const outPath = path.join(tmpDir, 'recovered-live.mp4');
      seedAndroidSession(context.daemon, 'default', PROVIDER_SCENARIO_ANDROID);
      const recordStop = await context.daemon.callCommand(
        'record',
        ['stop', outPath],
        {},
        { session: 'default' },
      );
      assertRpcError(recordStop, 'INVALID_ARGS', /no active recording/);
      assertAndroidOwnerlessRecordingNotRecovered(context);
    } finally {
      await context.daemon.close();
    }
  });
}

async function createAndroidRecordingRecoveryContext(): Promise<{
  remotePath: string;
  adbCalls: string[][];
  pullCalls: PullCall[];
  daemon: ProviderScenarioDaemon;
}> {
  const remotePath = '/sdcard/agent-device-recording-123456789.mp4';
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createPullingAndroidProvider({
        adbCalls,
        pullCalls,
        exec: (args) => androidRecoveryAdbResult(args, remotePath),
      }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  return { remotePath, adbCalls, pullCalls, daemon };
}

function assertAndroidOwnerlessRecordingNotRecovered(context: {
  remotePath: string;
  adbCalls: string[][];
  pullCalls: PullCall[];
}): void {
  const { adbCalls, pullCalls } = context;
  assert.equal(
    adbCalls.some((args) => args.join(' ') === 'shell ps -A -o pid=,args='),
    false,
  );
  assert.equal(
    adbCalls.some((args) => args.join(' ') === 'shell kill -2 4321'),
    false,
  );
  assert.equal(pullCalls.length, 0);
}

function seedAndroidSession(
  daemon: ProviderScenarioDaemon,
  name: string,
  device: typeof PROVIDER_SCENARIO_ANDROID,
): void {
  daemon.setSession(name, {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
  });
}

async function runAndroidPidReuseManifestScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const remotePath = '/sdcard/agent-device-recording-923456789.mp4';
  const manifest = buildAndroidRecordingManifest({
    outPath: path.join(tmpDir, 'pid-reuse.mp4'),
    remotePath,
    sessionName: 'default',
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => ({
      exec: async (args) => {
        adbCalls.push([...args]);
        const command = args.join(' ');
        if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
          return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
        }
        if (command === 'shell cat /data/local/tmp/agent-device-recording-active.json') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (command === 'shell ps -o pid=,args= -p 4321') {
          return { stdout: '4321 sh -c sleep 999\n', stderr: '', exitCode: 0 };
        }
        if (command === 'shell ps -A -o pid=,args=') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return androidAdbResult(args);
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await daemon.callCommand('record', ['stop'], {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
    });
    assertRpcError(recordStop, 'INVALID_ARGS', /no active recording/);
    assertCommandCall(adbCalls, [
      'shell',
      'rm',
      '-f',
      '/sdcard/agent-device-recording-active.json',
    ]);
  } finally {
    await daemon.close();
  }
}

async function runAndroidDeviceMismatchManifestScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const remotePath = '/sdcard/agent-device-recording-933456789.mp4';
  const manifest = {
    ...buildAndroidRecordingManifest({
      outPath: path.join(tmpDir, 'device-mismatch.mp4'),
      remotePath,
      sessionName: 'default',
    }),
    deviceId: 'wifi-emulator-5554',
  };
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => ({
      exec: async (args) => {
        adbCalls.push([...args]);
        const command = args.join(' ');
        if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
          return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
        }
        if (command === 'shell cat /data/local/tmp/agent-device-recording-active.json') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return androidAdbResult(args);
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await daemon.callCommand('record', ['stop'], {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
    });
    assertRpcError(recordStop, 'INVALID_ARGS', /manifest could not be validated/);
    assert.equal(
      adbCalls.some((args) => args.join(' ') === 'shell ps -A -o pid=,args='),
      false,
    );
    assert.equal(
      adbCalls.some(
        (args) => args.join(' ') === 'shell rm -f /sdcard/agent-device-recording-active.json',
      ),
      false,
    );
  } finally {
    await daemon.close();
  }
}

async function runAndroidUncertainMetadataScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const remotePath = '/sdcard/agent-device-recording-123456789.mp4';
  const manifest = buildAndroidRecordingManifest({
    outPath: path.join(tmpDir, 'uncertain.mp4'),
    remotePath,
    sessionName: 'default',
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => ({
      exec: async (args) => {
        adbCalls.push([...args]);
        const command = args.join(' ');
        if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
          return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
        }
        if (command === 'shell cat /data/local/tmp/agent-device-recording-active.json') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (command === 'shell ps -o pid=,args= -p 4321') {
          return { stdout: '', stderr: 'transient ps failure', exitCode: 1 };
        }
        if (command === 'shell ps -A -o pid=,args=') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return androidAdbResult(args);
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await daemon.callCommand('record', ['stop'], {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
    });
    assertRpcError(recordStop, 'INVALID_ARGS', /could not be verified/);
    assert.equal(
      adbCalls.some((args) => args.join(' ') === 'shell ps -A -o pid=,args='),
      false,
    );
    assert.equal(
      adbCalls.some(
        (args) => args.join(' ') === 'shell rm -f /sdcard/agent-device-recording-active.json',
      ),
      false,
    );
  } finally {
    await daemon.close();
  }
}

async function runAndroidCorruptMetadataScenario(_tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => ({
      exec: async (args) => {
        adbCalls.push([...args]);
        const command = args.join(' ');
        if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
          return { stdout: '{', stderr: '', exitCode: 0 };
        }
        if (command === 'shell cat /data/local/tmp/agent-device-recording-active.json') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (command === 'shell ps -A -o pid=,args=') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return androidAdbResult(args);
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStop = await daemon.callCommand('record', ['stop'], {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
    });
    assertRpcError(recordStop, 'INVALID_ARGS', /no active recording/);
    assertCommandCall(adbCalls, [
      'shell',
      'rm',
      '-f',
      '/sdcard/agent-device-recording-active.json',
    ]);
  } finally {
    await daemon.close();
  }
}

async function runAndroidSessionlessRecordingWithMockedAdb(logPath: string): Promise<void> {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-sessionless-record-',
    async (tmpDir) => await runAndroidSessionlessRecordingScenario(tmpDir, logPath),
  );
}

async function runAndroidSessionlessRecordingScenario(
  tmpDir: string,
  logPath: string,
): Promise<void> {
  const recordingPath = path.join(tmpDir, 'sessionless-recording.mp4');
  const adbCalls: string[][] = [];
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => createRecordingOnlyAndroidProvider(adbCalls),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStart = await daemon.callCommand('record', ['start', recordingPath]);
    assertRecordingStarted(recordStart, { showTouches: true });
    assertAndroidSessionlessRecording(adbCalls, logPath);
  } finally {
    await daemon.close();
  }
}

function assertAndroidSessionlessRecording(adbCalls: string[][], logPath: string): void {
  assert.ok(
    adbCalls.some((args) => isAndroidDefaultScreenrecordStartCommand(args.join(' '))),
    JSON.stringify(adbCalls),
  );
  assert.equal(
    adbCalls.some((args) => args.join(' ') === 'shell wm size'),
    false,
  );
  assert.deepEqual(readLoggedArgs(logPath), []);
}

async function withAndroidProviderScenarioEnv(
  tmpDir: string,
  runScenario: () => Promise<void>,
): Promise<void> {
  const previousPath = process.env.PATH;
  const previousSwiftCacheDir = process.env.AGENT_DEVICE_SWIFT_CACHE_DIR;
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_SWIFT_CACHE_DIR = path.join(tmpDir, 'swift-cache');
  try {
    await runScenario();
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', previousSwiftCacheDir);
  }
}

function createPullingAndroidProvider(params: {
  adbCalls: string[][];
  pullCalls: PullCall[];
  exec?: (args: string[]) => ReturnType<typeof androidAdbResult>;
}): AndroidAdbProvider {
  const { adbCalls, pullCalls, exec = androidAdbResult } = params;
  return {
    exec: async (args) => {
      adbCalls.push([...args]);
      return exec(args);
    },
    pull: async (remotePath, localPath) => {
      pullCalls.push({ remotePath, localPath });
      writePlayableMp4(localPath);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

function createStatefulAndroidRecordingProvider(params: {
  adbCalls: string[][];
  pullCalls: PullCall[];
}): AndroidAdbProvider & { manifest?: ReturnType<typeof buildAndroidRecordingManifest> } {
  const { adbCalls, pullCalls } = params;
  const provider: AndroidAdbProvider & {
    manifest?: ReturnType<typeof buildAndroidRecordingManifest>;
  } = {
    exec: async (args) => {
      adbCalls.push([...args]);
      const command = args.join(' ');
      const manifestPayload = extractManifestWritePayload(command);
      if (manifestPayload) {
        provider.manifest = JSON.parse(manifestPayload);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
        return provider.manifest
          ? { stdout: JSON.stringify(provider.manifest), stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'missing manifest', exitCode: 1 };
      }
      if (command === 'shell rm -f /sdcard/agent-device-recording-active.json') {
        delete provider.manifest;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command === 'shell ps -o pid=,args= -p 4321' && provider.manifest?.current) {
        return {
          stdout: `4321 screenrecord --bit-rate 8000000 ${provider.manifest.current.remotePath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      return androidAdbResult(args);
    },
    pull: async (remotePath, localPath) => {
      pullCalls.push({ remotePath, localPath });
      writePlayableMp4(localPath);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  return provider;
}

function extractManifestWritePayload(command: string): string | undefined {
  const prefix = "shell printf %s '";
  if (!command.startsWith(prefix)) return undefined;
  if (!command.includes('agent-device-recording-active.json.tmp')) return undefined;
  const payloadEnd = command.indexOf("' >", prefix.length);
  if (payloadEnd === -1) return undefined;
  return command.slice(prefix.length, payloadEnd).replace(/'\\''/g, "'");
}

function createAndroidManifestProvider(params: {
  adbCalls: string[][];
  manifests: Array<ReturnType<typeof buildAndroidRecordingManifest>>;
  pullCalls?: PullCall[];
}): AndroidAdbProvider {
  const { adbCalls, manifests, pullCalls } = params;
  return {
    exec: async (args) => {
      adbCalls.push([...args]);
      const command = args.join(' ');
      const manifest = findManifestForAdbCommand(manifests, command);
      if (manifest) {
        return manifest;
      }
      return androidAdbResult(args);
    },
    pull: async (remotePath, localPath) => {
      pullCalls?.push({ remotePath, localPath });
      writePlayableMp4(localPath);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

function findManifestForAdbCommand(
  manifests: Array<ReturnType<typeof buildAndroidRecordingManifest>>,
  command: string,
) {
  for (const manifest of manifests) {
    if (command === manifestCatCommand(manifest)) {
      return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
    }
    if (command === manifestPendingProcessCommand(manifest)) {
      return {
        stdout: `${manifest.pendingRemotePid} screenrecord --bit-rate 8000000 ${manifest.pending?.remotePath}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === manifestProcessCommand(manifest)) {
      assert.ok(manifest.current);
      return {
        stdout: `${manifest.current.remotePid} screenrecord --bit-rate 8000000 ${manifest.current.remotePath}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
  }
  return undefined;
}

function manifestCatCommand(manifest: ReturnType<typeof buildAndroidRecordingManifest>): string {
  const remotePath = manifest.current?.remotePath ?? manifest.pending?.remotePath;
  assert.ok(remotePath);
  const metadataPath = `${path.posix.dirname(remotePath)}/agent-device-recording-active.json`;
  return `shell cat ${metadataPath}`;
}

function manifestPendingProcessCommand(
  manifest: ReturnType<typeof buildAndroidRecordingManifest>,
): string {
  return manifest.pending ? 'shell ps -A -o pid=,args=' : '';
}

function manifestProcessCommand(
  manifest: ReturnType<typeof buildAndroidRecordingManifest>,
): string {
  if (!manifest.current) return '';
  return `shell ps -o pid=,args= -p ${manifest.current.remotePid}`;
}

function createRecordingOnlyAndroidProvider(adbCalls: string[][]): AndroidAdbProvider {
  return {
    exec: async (args) => {
      adbCalls.push([...args]);
      return androidAdbResult(args);
    },
  };
}

function androidRecoveryAdbResult(
  args: string[],
  remotePath: string,
): ReturnType<typeof androidAdbResult> {
  if (args.join(' ') === 'shell ps -A -o pid=,args=') {
    return {
      stdout: `4321 screenrecord --bit-rate 8000000 ${remotePath}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return androidAdbResult(args);
}

type AndroidRecordingManifestFixtureOptions = {
  outPath: string;
  remotePath: string;
  sessionName: string;
  sessionScope?: { kind: 'cwd'; id: string };
  status?: 'pending' | 'live' | 'rotating';
  pendingRemotePath?: string;
  pendingRemotePid?: string;
  remotePid?: string;
  startedAt?: number;
  chunks?: Array<{ index: number; path: string; remotePath: string }>;
};

function buildAndroidRecordingManifest(options: AndroidRecordingManifestFixtureOptions) {
  const startedAt = options.startedAt ?? 123456789;
  const status = options.status ?? 'live';
  return {
    version: 1,
    sessionName: options.sessionName,
    sessionScope: options.sessionScope,
    recordingId: `recording-${startedAt}`,
    deviceId: PROVIDER_SCENARIO_ANDROID.id,
    startedAt,
    outPath: options.outPath,
    showTouches: true,
    exportQuality: 'medium',
    current: buildAndroidRecordingManifestCurrent(options, startedAt, status),
    pending: buildAndroidRecordingManifestPending(options, status),
    pendingRemotePid: options.pendingRemotePid ?? (status === 'rotating' ? '4322' : '4321'),
    chunks: buildAndroidRecordingManifestChunks(options),
  };
}

function buildAndroidRecordingManifestCurrent(
  options: AndroidRecordingManifestFixtureOptions,
  startedAt: number,
  status: 'pending' | 'live' | 'rotating',
) {
  if (status === 'pending') return undefined;
  return {
    remotePath: options.remotePath,
    remotePid: options.remotePid ?? '4321',
    startedAt,
  };
}

function buildAndroidRecordingManifestPending(
  options: AndroidRecordingManifestFixtureOptions,
  status: 'pending' | 'live' | 'rotating',
) {
  return status === 'pending' || status === 'rotating'
    ? { remotePath: options.pendingRemotePath ?? options.remotePath }
    : undefined;
}

function buildAndroidRecordingManifestChunks(options: AndroidRecordingManifestFixtureOptions) {
  return (
    options.chunks ?? [
      {
        index: 1,
        path: options.outPath,
        remotePath: options.remotePath,
      },
    ]
  );
}

function hashScopeRoot(scopeRoot: string): string {
  return crypto.createHash('sha256').update(scopeRoot).digest('hex').slice(0, 16);
}

function androidAdbResult(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
} {
  const command = args.join(' ');
  if (command === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (command === 'shell wm size') {
    return {
      stdout: 'Physical size: 1440x2560\nOverride size: 1080x1920\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (
    /^shell screenrecord --size 756x1344 --bit-rate 20000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
      command,
    )
  ) {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  if (isAndroidScreenrecordStartCommand(command)) {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  if (/^shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)) {
    return { stdout: '2048\n', stderr: '', exitCode: 0 };
  }
  if (args[0] === 'pull' && typeof args[2] === 'string') {
    writePlayableMp4(args[2]);
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  if (command === 'shell ps -o pid= -p 4321') {
    return { stdout: '', stderr: '', exitCode: 1 };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

function isAndroidScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord (?:--size 756x1344 )?--bit-rate (?:8000000|20000000) \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

function isAndroidHighQualityScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord --size 756x1344 --bit-rate 20000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

function isAndroidDefaultScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

function readLoggedArgs(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function writePlayableMp4(filePath: string): void {
  const fixturePath = path.join(process.cwd(), 'website/docs/public/agent-device-contacts.mp4');
  if (fs.existsSync(fixturePath)) {
    fs.copyFileSync(fixturePath, filePath);
    return;
  }
  fs.writeFileSync(filePath, likelyPlayableMp4Container());
}
