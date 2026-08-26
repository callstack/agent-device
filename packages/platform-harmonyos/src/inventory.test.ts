import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  DeviceInventoryHostFor,
  HostCommandRequest,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { createHarmonyInventory, parseHarmonyTargetList } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('Harmony inventory parses targets, probes through the host port, and applies serial selection', async () => {
  assert.deepEqual(parseHarmonyTargetList('\n127.0.0.1:5555\n[Empty]\n'), ['127.0.0.1:5555']);
  const calls: HostCommandRequest[] = [];
  const host = createHost(async (request) => {
    calls.push(request);
    const key = request.args.join('\0');
    if (key === 'list\0targets') return result('emulator-1\nphysical-1\n');
    if (key.includes('const.product.name')) {
      return result(key.startsWith('-t\0emulator-1') ? 'emulator\n' : 'Mate 60\n');
    }
    if (key.includes('const.build.characteristics')) return result('tv\n');
    throw new Error(`Unexpected HDC invocation: ${key}`);
  });

  const devices = await createHarmonyInventory(host).discover({ serial: 'physical-1' }, scope);

  assert.deepEqual(devices, [
    {
      platform: 'harmonyos',
      id: 'physical-1',
      name: 'Mate 60',
      kind: 'device',
      target: 'tv',
      booted: true,
    },
  ]);
  assert.ok(calls.every((call) => call.executable === 'hdc'));
  assert.ok(calls.every((call) => call.timeoutMs === 10_000));
});

test('Harmony inventory resolves captured HDC toolchain roots without mutating host state', async () => {
  const host = createHost(
    async (request) => {
      assert.equal(request.executable, '/opt/deveco/default/openharmony/toolchains/hdc');
      return result('');
    },
    {
      which: async () => undefined,
      isExecutable: async (candidate) =>
        candidate === '/opt/deveco/default/openharmony/toolchains/hdc',
    },
  );

  assert.deepEqual(
    await createHarmonyInventory(host, { devecoSdkHome: '/opt/deveco' }).discover({}, scope),
    [],
  );
});

test('Harmony inventory prepares a configured legacy toolchain before discovery', async () => {
  const preparedFamilies: string[] = [];
  const host = {
    ...createHost(
      async (request) => {
        assert.equal(request.executable, '/opt/deveco/default/openharmony/toolchains/hdc');
        return result('');
      },
      {
        which: async () => undefined,
        isExecutable: async (candidate) =>
          candidate === '/opt/deveco/default/openharmony/toolchains/hdc',
      },
    ),
    toolchains: {
      prepare: async (family: string) => {
        preparedFamilies.push(family);
      },
    },
  };

  await createHarmonyInventory(host, { devecoSdkHome: '/opt/deveco' }).discover({}, scope);

  assert.deepEqual(preparedFamilies, ['harmonyos']);
});

test('Harmony inventory preserves the legacy curated HDC failure shape', async () => {
  const host = createHost(async () => result('ignored', 'transport failed', 7));

  await assert.rejects(createHarmonyInventory(host).discover({}, scope), (error: unknown) => {
    if (!(error instanceof Error) || !('details' in error)) return false;
    assert.deepEqual(error.details, {
      stderr: 'transport failed',
      hint: 'Confirm the HarmonyOS emulator or device is running, then run hdc list targets.',
    });
    return true;
  });
});

function createHost(
  run: DeviceInventoryHostFor<'harmonyos'>['commands']['run'],
  tools: {
    which?: DeviceInventoryHostFor<'harmonyos'>['commands']['which'];
    isExecutable?: DeviceInventoryHostFor<'harmonyos'>['files']['isExecutable'];
  } = {},
): DeviceInventoryHostFor<'harmonyos'> {
  return {
    commands: { which: tools.which ?? (async () => 'hdc'), run },
    toolchains: { prepare: async () => undefined },
    files: {
      isExecutable: tools.isExecutable ?? (async () => false),
      createTemporaryTextFile: async () => {
        throw new Error('unused');
      },
    },
  };
}

function result(stdout: string, stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode };
}
