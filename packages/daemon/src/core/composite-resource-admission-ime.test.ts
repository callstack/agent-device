import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ANDROID_EMULATOR } from '@agent-device/test-kit';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import { AppError } from '@agent-device/kernel/errors';
import { bindAndroidImeTestHost } from '@agent-device/platform-android/snapshot-capture-fixtures';
import {
  activateAndroidTestIme,
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
  restoreAndroidTestIme,
  withAndroidAdbProvider,
} from '@agent-device/platform-android/mechanics';
import { resourceAdmissionWorld, assertRpcOk } from './composite-resource-admission.fixtures.ts';

const originalIme = 'com.google.android.inputmethod.latin/.LatinIME';
const helperIme = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test.each(['batch', 'replay'] as const)(
  'bounded %s restores owned Android IME at authored close',
  async (mode) => {
    const helper = androidHelperWorld();
    const world = await resourceAdmissionWorld('capture', { ime: helper.ime });
    try {
      world.sessionStore.retire(world.ref);
      const script = path.join(world.daemon.stateDir, 'ime-open-close.ad');
      const source = 'open com.android.settings\nhome\nclose\n';
      if (mode === 'replay') fs.writeFileSync(script, source);
      const response =
        mode === 'batch'
          ? await world.call('batch', [], {
              batchSteps: [
                {
                  command: 'open',
                  positionals: ['com.android.settings'],
                  flags: { testIme: true },
                },
                { command: 'home' },
                { command: 'close' },
              ],
            })
          : await world.call('replay', [script], {
              testIme: true,
              replayScriptSource: { entry: script, files: { [script]: source } },
            });
      assertRpcOk(response);
      expect(helper.imeSelections()).toEqual([helperIme, originalIme]);
      expect(helper.currentIme()).toBe(originalIme);
      expect(helper.previousIme()).toBeUndefined();
      expect(helper.markers()).toEqual([]);
      expect(isAndroidTestImeActive(ANDROID_EMULATOR)).toBe(false);
      expect(world.sessionStore.listRefs()).toHaveLength(0);
      expect(
        inspectDeviceClaims(
          { serial: ANDROID_EMULATOR.id },
          { AGENT_DEVICE_CLAIMS_DIR: path.join(world.daemon.stateDir, 'claims') },
        ),
      ).toEqual([]);
      expect(world.home).toHaveBeenCalledOnce();
    } finally {
      await world.daemon.close();
    }
  },
);

test('Maestro stop keeps the IME and app log; capture still bars caller close', async () => {
  const helper = androidHelperWorld();
  const world = await resourceAdmissionWorld('capture', { ime: helper.ime });
  try {
    assertRpcOk(await world.call('open', ['com.android.settings'], { testIme: true }));
    assertRpcOk(await world.call('logs', ['start']));
    const flow = path.join(world.daemon.stateDir, 'stop-app.yaml');
    assertRpcOk(
      await world.call('replay', [flow], {
        replayBackend: 'maestro',
        replayScriptSource: {
          entry: flow,
          files: { [flow]: 'appId: com.android.settings\n---\n- stopApp\n' },
        },
      }),
    );
    expect(helper.currentIme()).toBe(helperIme);
    expect(world.sessionStore.listRefs()).toHaveLength(1);
    assertRpcOk(
      await world.call('batch', [], {
        batchSteps: [
          { command: 'open', positionals: ['com.android.settings'], flags: { relaunch: true } },
        ],
      }),
    );
    expect(helper.currentIme()).toBe(helperIme);
    const binds = world.bind.mock.calls.length;
    const facts = world.inspectFacts.mock.calls.length;
    const refused = await world.call('batch', [], { batchSteps: [{ command: 'close' }] });
    expect(refused.json.error?.data?.details).toMatchObject({
      reason: 'bounded_composite_resource_unsupported',
      shape: 'session-resource-disposal:app-log',
      standaloneCommandName: 'close',
      dispatched: 'no',
      executed: 0,
    });
    expect(world.bind).toHaveBeenCalledTimes(binds);
    expect(world.inspectFacts).toHaveBeenCalledTimes(facts);
    expect(world.finish).not.toHaveBeenCalled();
    expect(world.native).not.toHaveBeenCalled();
    expect(helper.currentIme()).toBe(helperIme);
    assertRpcOk(await world.call('logs', ['stop']));
    assertRpcOk(await world.call('batch', [], { batchSteps: [{ command: 'close' }] }));
    expect(helper.currentIme()).toBe(originalIme);
    expect(world.sessionStore.listRefs()).toHaveLength(0);
  } finally {
    await world.daemon.close();
  }
});

test.each(['batch', 'replay'] as const)(
  'bounded %s reports failed IME restore and retains recovery ownership',
  async (mode) => {
    const helper = androidHelperWorld(true);
    const world = await resourceAdmissionWorld('capture', { ime: helper.ime });
    try {
      world.sessionStore.retire(world.ref);
      assertRpcOk(await world.call('open', ['com.android.settings'], { testIme: true }));
      const script = path.join(world.daemon.stateDir, 'ime-failed-close.ad');
      const source = 'home\nclose\n';
      if (mode === 'replay') fs.writeFileSync(script, source);
      const failed =
        mode === 'batch'
          ? await world.call('batch', [], {
              batchSteps: [{ command: 'home' }, { command: 'close' }],
            })
          : await world.call('replay', [script], {
              replayScriptSource: { entry: script, files: { [script]: source } },
            });
      expect(failed.json.error?.data?.details).toMatchObject({
        reason: 'session_cleanup_incomplete',
        failedSteps: ['application_lifecycle'],
        dispatchedSteps: 1,
      });
      expect(world.home).toHaveBeenCalledOnce();
      expect(helper.currentIme()).toBe(helperIme);
      expect(helper.previousIme()).toBe(originalIme);
      expect(helper.markers()).toEqual([ANDROID_EMULATOR.id]);
      expect(world.sessionStore.listRefs()).toHaveLength(0);
      const claims = inspectDeviceClaims(
        { serial: ANDROID_EMULATOR.id },
        { AGENT_DEVICE_CLAIMS_DIR: path.join(world.daemon.stateDir, 'claims') },
      );
      expect(claims[0]?.claim?.session).toBe('resource-session');
      assertRpcOk(await world.call('open', ['com.android.settings'], { testIme: true }));
      assertRpcOk(await world.call('close'));
      expect(helper.currentIme()).toBe(originalIme);
      expect(helper.previousIme()).toBeUndefined();
    } finally {
      await world.daemon.close();
    }
  },
);

test('expired replay budget stops before IME close dispatch', async () => {
  const helper = androidHelperWorld();
  const world = await resourceAdmissionWorld('capture', { ime: helper.ime });
  try {
    assertRpcOk(await world.call('open', ['com.android.settings'], { testIme: true }));
    const started = gate();
    const release = gate();
    world.home.mockImplementationOnce(async () => {
      started.release();
      await release.promise;
    });
    const script = path.join(world.daemon.stateDir, 'ime-preclose-timeout.ad');
    const source = 'home\nclose\n';
    fs.writeFileSync(script, source);
    vi.useFakeTimers();
    const pending = world.call('replay', [script], {
      timeoutMs: 1_000,
      replayScriptSource: { entry: script, files: { [script]: source } },
    });
    await started.promise;
    const binds = world.bind.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_001);
    release.release();
    const result = await pending;
    expect(result.json.error?.data?.details?.reason).toBe('daemon_request_timeout');
    expect(world.bind).toHaveBeenCalledTimes(binds);
    expect(helper.currentIme()).toBe(helperIme);
    expect(world.sessionStore.listRefs()).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await world.daemon.close();
  }
});

test('restore already started settles after replay budget expires', async () => {
  const helper = androidHelperWorld();
  const started = gate();
  const release = gate();
  const restore = helper.ime.restore;
  helper.ime.restore = async (stateDir) => {
    started.release();
    await release.promise;
    await restore(stateDir);
  };
  const world = await resourceAdmissionWorld('capture', { ime: helper.ime });
  try {
    assertRpcOk(await world.call('open', ['com.android.settings'], { testIme: true }));
    const script = path.join(world.daemon.stateDir, 'ime-midclose-timeout.ad');
    const source = 'close\n';
    fs.writeFileSync(script, source);
    vi.useFakeTimers();
    const pending = world.call('replay', [script], {
      timeoutMs: 1_000,
      replayScriptSource: { entry: script, files: { [script]: source } },
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(1_001);
    release.release();
    assertRpcOk(await pending);
    expect(helper.currentIme()).toBe(originalIme);
    expect(helper.markers()).toEqual([]);
    expect(world.sessionStore.listRefs()).toHaveLength(0);
  } finally {
    vi.useRealTimers();
    await world.daemon.close();
  }
});

function androidHelperWorld(failRestoreOnce = false) {
  let currentIme = originalIme;
  let previousIme: string | undefined;
  let failRestore = failRestoreOnce;
  const imeSelections: string[] = [];
  const readMarkers = bindAndroidImeTestHost();
  let imeStateDir: string | undefined;
  const settings = (command: readonly string[]): string => {
    switch (command[1]) {
      case 'get':
        if (command.at(-1) === 'default_input_method') return currentIme;
        return command.at(-1) === 'agent_device_ime_helper_previous_ime'
          ? (previousIme ?? 'null')
          : 'null';
      case 'put':
        previousIme = command.at(-1);
        return '';
      case 'delete':
        previousIme = undefined;
        return '';
      default:
        throw new Error(`Unexpected settings operation: ${command.join(' ')}`);
    }
  };
  const ime = (command: readonly string[]): string => {
    if (command[1] === 'set') {
      const selected = command.at(-1)!;
      if (selected === originalIme && failRestore) failRestore = false;
      else currentIme = selected;
      imeSelections.push(selected);
    } else if (command[1] !== 'enable')
      throw new Error(`Unexpected IME operation: ${command.join(' ')}`);
    return '';
  };
  const provider = {
    imeHelperArtifact: {
      apkPath: '/unused/helper.apk',
      manifest: {
        name: 'android-ime-helper' as const,
        version: '1.0.0',
        assetName: 'helper.apk',
        sha256: '0'.repeat(64),
        packageName: 'com.callstack.agentdevice.imehelper',
        versionCode: 1,
        serviceComponent: helperIme,
        broadcastProtocol: 'android-ime-helper-v1' as const,
      },
    },
    exec: async (args: readonly string[]) => {
      const shell = args.indexOf('shell');
      const command = args.slice(shell + 1);
      let stdout: string;
      if (command[0] === 'settings') stdout = settings(command);
      else if (command[0] === 'ime') stdout = ime(command);
      else throw new Error(`Unexpected fake ADB operation: ${command.join(' ')}`);
      return { stdout, stderr: '', exitCode: 0 };
    },
  };
  const inProvider = async <T>(fn: () => Promise<T>) =>
    await withAndroidAdbProvider(provider, { serial: ANDROID_EMULATOR.id }, fn);
  return {
    currentIme: () => currentIme,
    previousIme: () => previousIme,
    markers: () => (imeStateDir ? readMarkers(imeStateDir) : []),
    imeSelections: () => [...imeSelections],
    ime: {
      activate: async (stateDir: string) => {
        imeStateDir = stateDir;
        const result = await inProvider(
          async () => await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir }),
        );
        if (result.outcome !== 'settled') throw new Error(result.reason);
        expect(result.activated || result.alreadyActive).toBe(true);
      },
      restore: async (stateDir: string) => {
        const result = await inProvider(
          async () => await restoreAndroidTestIme(ANDROID_EMULATOR, { stateDir }),
        );
        if (result.reason === 'set-failed') {
          throw new AppError('COMMAND_FAILED', 'Android test IME could not be restored.', {
            reason: 'android_test_ime_restore_incomplete',
            deviceId: ANDROID_EMULATOR.id,
          });
        }
        expect(result.reason).toBe('ok');
      },
    },
  };
}

afterEach(() => resetAndroidTestImeActivationCacheForTests());

test('nested Android test restores its activated helper after primary resource refusal', async () => {
  const helper = androidHelperWorld();
  const world = await resourceAdmissionWorld('capture', { ime: helper.ime });
  try {
    world.sessionStore.retire(world.ref);
    const script = path.join(world.daemon.stateDir, 'android-ime-resource.ad');
    const source = 'open com.android.settings\nperf memory snapshot\n';
    fs.writeFileSync(script, source);
    const flags = {
      replayScriptSources: [{ entry: script, files: { [script]: source } }],
      artifactsDir: path.join(world.daemon.stateDir, 'android-ime-artifacts'),
    };
    const nested = await world.call('batch', [], {
      batchSteps: [{ command: 'test', positionals: [script], flags }],
    });
    expect(JSON.stringify(nested.json)).toContain('bounded_composite_resource_unsupported');
    expect(JSON.stringify(nested.json)).toContain('perf:memory-snapshot');
    const details = nested.json.result.data.results[0].data.failures[0].error.details;
    expect(details.standaloneCommandName).toBe('test');
    expect(details).not.toHaveProperty('standaloneCommand');
    expect(details.divergence.cause.hint).toContain('original test');
    expect(details.divergence.cause.hint).toContain('live outer session');
    expect(details.divergence.cause.hint).not.toContain('attempt-1');
    expect(details.divergence.screen.hint).toBe(details.divergence.cause.hint);
    expect(helper.imeSelections()).toEqual([helperIme, originalIme]);
    expect(helper.currentIme()).toBe(originalIme);
    expect(helper.previousIme()).toBeUndefined();
    expect(isAndroidTestImeActive(ANDROID_EMULATOR)).toBe(false);
    expect(world.sessionStore.listRefs()).toHaveLength(0);
    expect(world.native).not.toHaveBeenCalled();
    const direct = await world.call('test', [script], flags);
    expect(JSON.stringify(direct.json)).not.toContain('bounded_composite_resource_unsupported');
    expect(world.native).toHaveBeenCalledOnce();
    expect(helper.imeSelections()).toEqual([helperIme, originalIme, helperIme, originalIme]);
    expect(helper.currentIme()).toBe(originalIme);
    expect(world.sessionStore.listRefs()).toHaveLength(0);
  } finally {
    await world.daemon.close();
  }
});
