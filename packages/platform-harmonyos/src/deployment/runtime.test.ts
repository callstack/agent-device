import { expect, test, vi } from 'vitest';
import type {
  HostCommandRunner,
  HostCommandResult,
} from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyAppDeploymentOperations, harmonyAppDeploymentFacts } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-deployment-fact',
  name: 'HarmonyOS',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test.each([
  ['emulator', device, true],
  ['physical device', { ...device, kind: 'device' as const }, true],
  ['invalid simulator kind', { ...device, kind: 'simulator' as const }, false],
] as const)(
  'classifies HarmonyOS deployment facts for the %s denominator cell',
  (_name, runtimeDevice, deployAvailable) => {
    const facts = harmonyAppDeploymentFacts(runtimeDevice);
    expect(facts.deployApp.available).toBe(deployAvailable);
    expect(facts.uninstallApp.available).toBe(deployAvailable);
    if (!deployAvailable) {
      expect(facts.deployApp).toMatchObject({ reason: 'unsupported-device-kind' });
      expect(facts.uninstallApp).toMatchObject({ reason: 'unsupported-device-kind' });
    }
    for (const fact of [
      facts.materializeAppSource,
      facts.deployMaterializedApp,
      facts.sendPushNotification,
    ]) {
      expect(fact).toMatchObject({ available: false, reason: 'unsupported-platform-leaf' });
    }
  },
);

test('exposes HarmonyOS deployApp and uninstallApp after fact admission', async () => {
  const run = vi.fn(async (request: { executable: string; args: readonly string[] }) => ({
    stdout:
      request.executable === 'unzip'
        ? '{"app":{"bundleName":"com.example.app"}}'
        : request.args.includes('dump')
          ? '{"hapModuleInfos":[{"mainElementName":"MainAbility","moduleName":"entry"}]}'
          : '',
    stderr: '',
    exitCode: 0,
  }));
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });
  await operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/app.hap',
    replaceExisting: false,
  });
  await operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/app.hap',
    replaceExisting: true,
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'install', '-r', '/tmp/app.hap'],
    }),
    signal,
  );
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      executable: 'hdc',
      args: [
        '-t',
        device.id,
        'shell',
        'aa',
        'start',
        '-b',
        'com.example.app',
        '-m',
        'entry',
        '-a',
        'MainAbility',
      ],
    }),
    signal,
  );
  expect(operations).not.toHaveProperty('materializeAppSource');
  expect(
    createHarmonyAppDeploymentOperations({
      commands,
      device: { ...device, kind: 'simulator' },
      signal,
    }),
  ).toEqual({});
});

const installedDump: HostCommandResult = {
  stdout: '{"hapModuleInfos":[{"mainElementName":"MainAbility","moduleName":"entry"}]}',
  stderr: '',
  exitCode: 0,
};

test('uninstall removes an installed HarmonyOS bundle through bm uninstall', async () => {
  const uninstallAnswer: HostCommandResult = {
    stdout: 'uninstall bundle successfully.',
    stderr: '',
    exitCode: 0,
  };
  const run = vi.fn(
    scriptAnswers([installedDump, uninstallAnswer, absentBundleAnswer, emptyAnswer]),
  );
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).resolves.toEqual({
    wasInstalled: true,
    packageName: 'com.example.app',
  });
  expect(run).toHaveBeenCalledTimes(4);
  expect(run).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'shell', 'bm', 'dump', '-n', 'com.example.app'],
    }),
    signal,
  );
  expect(run).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'shell', 'bm', 'uninstall', '-n', 'com.example.app'],
    }),
    signal,
  );
  expect(run).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'shell', 'bm', 'dump', '-n', 'com.example.app'],
    }),
    signal,
  );
  expect(run).toHaveBeenNthCalledWith(
    4,
    expect.objectContaining({ args: ['-t', device.id, 'shell', 'true'] }),
    signal,
  );
});

test('uninstall refuses to claim removal when the bundle record survives bm uninstall', async () => {
  const lyingUninstallAnswer: HostCommandResult = {
    stdout: 'uninstall bundle successfully.',
    stderr: '',
    exitCode: 0,
  };
  const run = vi.fn(scriptAnswers([installedDump, lyingUninstallAnswer, installedDump]));
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'com.example.app is still installed after bm uninstall',
    details: { stdout: 'uninstall bundle successfully.' },
  });
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).not.toHaveBeenCalledWith(
    expect.objectContaining({ args: ['-t', device.id, 'shell', 'true'] }),
    signal,
  );
});

/** Answers each call in order; the last answer repeats when a script runs past its end. */
function scriptAnswers(answers: readonly HostCommandResult[]) {
  let next = 0;
  return async (): Promise<HostCommandResult> => answers[Math.min(next++, answers.length - 1)]!;
}

const emptyAnswer: HostCommandResult = { stdout: '', stderr: '', exitCode: 0 };

/**
 * Shapes recorded on physical hardware: an absent bundle answers through bm with an
 * error record, while an unreachable target answers through hdc itself and still
 * exits zero. The second probe call classifies the two.
 */
const absentBundleAnswer: HostCommandResult = {
  stdout: 'error: failed to get information and the parameters may be wrong.',
  stderr: '',
  exitCode: 0,
};
const unreachableAnswer: HostCommandResult = {
  stdout: '[Fail]Not match target founded, check connect-key please',
  stderr: '',
  exitCode: 0,
};

function scriptUninstallCommands(
  responses: Readonly<{ dump: HostCommandResult; probe?: HostCommandResult }>,
): HostCommandRunner {
  const run = vi.fn(async (request: { executable: string; args: readonly string[] }) => {
    if (request.args.includes('dump')) return responses.dump;
    if (request.args.includes('true')) return responses.probe ?? emptyAnswer;
    return emptyAnswer;
  });
  return { which: async () => undefined, run } as HostCommandRunner;
}

test('uninstall reports an absent record as nothing removed once the transport proves alive', async () => {
  const commands = scriptUninstallCommands({ dump: absentBundleAnswer });
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).resolves.toEqual({
    wasInstalled: false,
  });
  expect(commands.run).toHaveBeenCalledTimes(2);
  expect(commands.run).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ args: ['-t', device.id, 'shell', 'true'] }),
    signal,
  );
});

test.each([
  [
    'an unreachable target that hdc answers while exiting zero',
    { dump: unreachableAnswer, probe: unreachableAnswer },
    2,
  ],
  [
    'a dump that exits non-zero on a dead transport',
    {
      dump: { stdout: '[Fail]Device not connected', stderr: '', exitCode: 1 },
      probe: { stdout: '[Fail]Device not connected', stderr: '', exitCode: 1 },
    },
    2,
  ],
  ['a dump killed before an answer', { dump: { stdout: '', stderr: '', exitCode: null } }, 1],
] as const)(
  'uninstall refuses to claim removal for %s',
  async (_name, responses, expectedCalls) => {
    const commands = scriptUninstallCommands(responses);
    const signal = new AbortController().signal;
    const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

    await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
    expect(commands.run).toHaveBeenCalledTimes(expectedCalls);
    expect(commands.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(['uninstall']) }),
      signal,
    );
  },
);

test('uninstall refuses to claim removal when the post-uninstall dump cannot be verified', async () => {
  const run = vi.fn(
    scriptAnswers([installedDump, emptyAnswer, absentBundleAnswer, unreachableAnswer]),
  );
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Could not verify the uninstall of com.example.app',
  });
  expect(run).toHaveBeenCalledTimes(4);
});

test('uninstall refuses a blank bundle name', async () => {
  const run = vi.fn();
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: '   ' })).rejects.toMatchObject({
    code: 'INVALID_ARGS',
  });
  expect(run).not.toHaveBeenCalled();
});
