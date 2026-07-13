import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { test } from 'vitest';

import { IOS_DEVICE } from '../../../../__tests__/test-utils/index.ts';
import { AppError } from '../../../../kernel/errors.ts';
import { closeIosApp } from '../app-launch.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';

const APP_BUNDLE_ID = 'com.example.demo';
const APP_BUNDLE_URL = 'file:///private/var/containers/Bundle/Application/ABC123/Demo.app/';

test('closeIosApp terminates a physical iOS app by its resolved process ID', async () => {
  const calls: string[][] = [];
  const provider = createLocalAppleToolProvider({
    devicectl: {
      run: async (args) => {
        calls.push(args);
        if (args.slice(0, 4).join(' ') === 'device info apps --device') {
          await writeJsonOutput(args, {
            result: {
              apps: [{ bundleIdentifier: APP_BUNDLE_ID, name: 'Demo', url: APP_BUNDLE_URL }],
            },
          });
        } else if (args.slice(0, 4).join(' ') === 'device info processes --device') {
          await writeJsonOutput(args, {
            result: {
              runningProcesses: [
                {
                  executable: `${APP_BUNDLE_URL}PlugIns/Share.appex/Share`,
                  processIdentifier: 422,
                },
                {
                  executable: `${APP_BUNDLE_URL}Demo`,
                  processIdentifier: 421,
                },
              ],
            },
          });
        } else if (args.includes('terminate')) {
          await writeJsonOutput(args, { info: { outcome: 'success' } });
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  await withAppleToolProvider(provider, async () => {
    await closeIosApp(IOS_DEVICE, APP_BUNDLE_ID);
  });

  const terminateCall = calls.at(-1);
  assert.deepEqual(terminateCall?.slice(0, 8), [
    'device',
    'process',
    'terminate',
    '--device',
    IOS_DEVICE.id,
    '--pid',
    '421',
    '--kill',
  ]);
  assert.equal(terminateCall?.includes('--json-output'), true);
  assert.equal(terminateCall?.includes(APP_BUNDLE_ID), false);
});

test('closeIosApp tolerates the process exiting after PID resolution', async () => {
  await withAppleToolProvider(createTerminateFailureProvider(3), async () => {
    await closeIosApp(IOS_DEVICE, APP_BUNDLE_ID);
  });
});

test('closeIosApp preserves termination failures other than an exited process', async () => {
  await assert.rejects(
    () =>
      withAppleToolProvider(createTerminateFailureProvider(1), async () => {
        await closeIosApp(IOS_DEVICE, APP_BUNDLE_ID);
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Failed to terminate iOS app');
      return true;
    },
  );
});

test('closeIosApp reports the required devicectl process-list API', async () => {
  const provider = createLocalAppleToolProvider({
    devicectl: {
      run: async (args) => {
        if (args.slice(0, 4).join(' ') === 'device info apps --device') {
          await writeJsonOutput(args, {
            result: {
              apps: [{ bundleIdentifier: APP_BUNDLE_ID, name: 'Demo', url: APP_BUNDLE_URL }],
            },
          });
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return {
          exitCode: 64,
          stdout: '',
          stderr: "Error: Unknown subcommand 'processes'",
        };
      },
    },
  });

  await assert.rejects(
    () =>
      withAppleToolProvider(provider, async () => {
        await closeIosApp(IOS_DEVICE, APP_BUNDLE_ID);
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Failed to list iOS processes');
      assert.match(String(error.details?.hint), /devicectl device info processes/);
      assert.match(String(error.details?.stderr), /Unknown subcommand 'processes'/);
      return true;
    },
  );
});

test('closeIosApp fails closed when devicectl changes the process-list response shape', async () => {
  const calls: string[][] = [];
  const provider = createLocalAppleToolProvider({
    devicectl: {
      run: async (args) => {
        calls.push(args);
        if (args.slice(0, 4).join(' ') === 'device info apps --device') {
          await writeJsonOutput(args, {
            result: {
              apps: [{ bundleIdentifier: APP_BUNDLE_ID, name: 'Demo', url: APP_BUNDLE_URL }],
            },
          });
        } else if (args.slice(0, 4).join(' ') === 'device info processes --device') {
          await writeJsonOutput(args, { result: { processes: [] } });
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  await assert.rejects(
    () =>
      withAppleToolProvider(provider, async () => {
        await closeIosApp(IOS_DEVICE, APP_BUNDLE_ID);
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Unsupported iOS process list response');
      assert.match(String(error.details?.hint), /JSON runningProcesses/);
      return true;
    },
  );
  assert.equal(
    calls.some((args) => args.includes('terminate')),
    false,
  );
});

async function writeJsonOutput(args: string[], payload: unknown): Promise<void> {
  const outputIndex = args.indexOf('--json-output');
  const outputPath = args[outputIndex + 1];
  assert.ok(outputPath);
  await fs.writeFile(outputPath, JSON.stringify(payload), 'utf8');
}

function createTerminateFailureProvider(underlyingCode: number) {
  return createLocalAppleToolProvider({
    devicectl: {
      run: async (args) => {
        if (args.slice(0, 4).join(' ') === 'device info apps --device') {
          await writeJsonOutput(args, {
            result: {
              apps: [{ bundleIdentifier: APP_BUNDLE_ID, name: 'Demo', url: APP_BUNDLE_URL }],
            },
          });
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args.slice(0, 4).join(' ') === 'device info processes --device') {
          await writeJsonOutput(args, {
            result: {
              runningProcesses: [{ executable: `${APP_BUNDLE_URL}Demo`, processIdentifier: 421 }],
            },
          });
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        await writeJsonOutput(args, {
          error: {
            userInfo: {
              NSUnderlyingError: {
                error: { code: underlyingCode, domain: 'NSPOSIXErrorDomain' },
              },
            },
          },
        });
        return { exitCode: 1, stdout: '', stderr: 'Process termination failed.' };
      },
    },
  });
}
