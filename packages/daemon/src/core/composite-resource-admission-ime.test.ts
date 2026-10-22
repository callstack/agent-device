import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ANDROID_EMULATOR } from '@agent-device/test-kit';
import { bindAndroidImeTestHost } from '@agent-device/platform-android/snapshot-capture-fixtures';
import {
  activateAndroidTestIme,
  inspectAndroidSessionTeardownResources,
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
  restoreAndroidTestIme,
  withAndroidAdbProvider,
} from '@agent-device/platform-android/mechanics';
import { resourceAdmissionWorld } from './composite-resource-admission.fixtures.ts';

const originalIme = 'com.google.android.inputmethod.latin/.LatinIME';
const helperIme = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';

function androidHelperWorld() {
  let currentIme = originalIme;
  let previousIme: string | undefined;
  const imeSelections: string[] = [];
  bindAndroidImeTestHost();
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
      currentIme = command.at(-1)!;
      imeSelections.push(currentIme);
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
    imeSelections: () => [...imeSelections],
    ime: {
      activate: async (stateDir: string) => {
        const result = await inProvider(
          async () => await activateAndroidTestIme(ANDROID_EMULATOR, { stateDir }),
        );
        expect(result).toMatchObject({ outcome: 'settled', activated: true });
      },
      restore: async (stateDir: string) => {
        const result = await inProvider(
          async () => await restoreAndroidTestIme(ANDROID_EMULATOR, { stateDir }),
        );
        expect(result.reason).toBe('ok');
      },
      inspect: inspectAndroidSessionTeardownResources,
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
    expect(JSON.stringify(nested.json)).toContain('agent-device test');
    expect(JSON.stringify(nested.json)).toContain('--session resource-session');
    const details = nested.json.result.data.results[0].data.failures[0].error.details;
    expect(details.standaloneCommand).toContain(`agent-device test ${script}`);
    expect(details.divergence.cause.hint).toContain('agent-device test');
    expect(details.divergence.cause.hint).not.toContain('agent-device perf');
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
