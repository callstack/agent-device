import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { withAndroidAdbProvider, type AndroidAdbExecutor } from '../adb-executor.ts';
import {
  activateAndroidTestIme,
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
  restoreOrphanedAndroidTestImeOnDaemonStartup,
} from '../ime-lifecycle.ts';
import {
  resetStartupRecoveryFencesForTests,
  runStartupRecoveryFence,
} from '@agent-device/contracts/startup-recovery-fence';

const HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const LATIN_IME = 'com.google.android.inputmethod.latin/.LatinIME';
const PREVIOUS_IME_KEY = 'agent_device_ime_helper_previous_ime';
const STATE_DIR = '/ime-race-state';
const SERIAL = ANDROID_EMULATOR.id;

const markerState = vi.hoisted(() => ({ pending: new Set<string>() }));

// The durable filesystem marker itself is covered in ime-lifecycle.test.ts. This focused race
// fixture uses synchronous-in-effect marker promises so the interleaving is deterministic: with
// the per-device fence removed, recovery reaches and retires the marker before the blocked switch.
vi.mock('../ime-recovery-marker.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ime-recovery-marker.ts')>();
  return {
    ...actual,
    readAndroidTestImeRecoveryMarkers: vi.fn(async () => [...markerState.pending]),
    writeAndroidTestImeRecoveryMarker: vi.fn(async (_stateDir: string, serial: string) => {
      markerState.pending.add(serial);
      return true;
    }),
    clearAndroidTestImeRecoveryMarker: vi.fn(async (_stateDir: string, serial: string) => {
      markerState.pending.delete(serial);
    }),
  };
});

vi.mock('../ime-helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ime-helper.ts')>();
  // Lazy: the factory is hoisted above this file's top-level constants.
  const artifact = () => ({
    apkPath: '/fixture/ime-helper.apk',
    manifest: {
      name: 'android-ime-helper' as const,
      version: '0.0.0',
      assetName: 'ime-helper.apk',
      sha256: 'fixture',
      packageName: 'com.callstack.agentdevice.imehelper',
      versionCode: 1,
      serviceComponent: HELPER_SERVICE,
      broadcastProtocol: 'android-ime-helper-v1' as const,
    },
  });
  return {
    ...actual,
    ensureAndroidImeHelper: vi.fn(async () => undefined),
    // Both the bundled resolver and the provider-aware selector answer with this fixture.
    resolveAndroidImeHelperArtifact: vi.fn(async () => artifact()),
    selectAndroidImeHelperArtifact: vi.fn(async () => artifact()),
  };
});

beforeEach(() => {
  markerState.pending.clear();
  resetAndroidTestImeActivationCacheForTests();
  resetStartupRecoveryFencesForTests();
});

test('planted race: startup recovery cannot retire an activation marker before the fenced IME switch', async () => {
  let currentIme = LATIN_IME;
  let previousIme: string | undefined;
  const enable = deferred();
  const recoveryListed = deferred();
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.join(' ') === 'shell settings get secure default_input_method') {
      return { exitCode: 0, stdout: `${currentIme}\n`, stderr: '' };
    }
    if (args.join(' ') === `shell settings get secure ${PREVIOUS_IME_KEY}`) {
      return { exitCode: 0, stdout: `${previousIme ?? 'null'}\n`, stderr: '' };
    }
    if (args.slice(0, 5).join(' ') === `shell settings put secure ${PREVIOUS_IME_KEY}`) {
      previousIme = args[5];
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.join(' ') === `shell settings delete secure ${PREVIOUS_IME_KEY}`) {
      previousIme = undefined;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.slice(0, 3).join(' ') === 'shell ime enable') {
      enable.signalStarted();
      await enable.released;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.slice(0, 3).join(' ') === 'shell ime set') {
      currentIme = args[3] as string;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };

  await withAndroidAdbProvider(adb, { serial: SERIAL }, async () => {
    const activation = activateAndroidTestIme(ANDROID_EMULATOR, { stateDir: STATE_DIR });
    await enable.started;
    assert.equal(markerState.pending.has(SERIAL), true);

    const recovery = runStartupRecoveryFence(STATE_DIR, async () => {
      await restoreOrphanedAndroidTestImeOnDaemonStartup({
        stateDir: STATE_DIR,
        listSerials: async () => {
          recoveryListed.signalStarted();
          return [SERIAL];
        },
      });
    });
    await recoveryListed.started;
    await flushMicrotasks();

    try {
      // Planted-red proof: removing the shared per-device lock causes recovery to read the
      // inactive IME, classify it clean, and clear this marker before `ime set` can run.
      assert.equal(markerState.pending.has(SERIAL), true);
    } finally {
      enable.release();
      await activation;
      await recovery;
    }

    assert.equal(currentIme, HELPER_SERVICE);
    assert.equal(isAndroidTestImeActive(ANDROID_EMULATOR), true);
    assert.equal(markerState.pending.has(SERIAL), true);
  });
});

function deferred(): {
  started: Promise<void>;
  signalStarted: () => void;
  released: Promise<void>;
  release: () => void;
} {
  let start!: () => void;
  let release!: () => void;
  return {
    started: new Promise<void>((resolve) => {
      start = resolve;
    }),
    signalStarted: () => start(),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}
