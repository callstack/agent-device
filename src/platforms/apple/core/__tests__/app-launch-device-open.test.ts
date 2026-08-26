import assert from 'node:assert/strict';
import { test } from 'vitest';
import { IOS_SIMULATOR, MACOS_DEVICE } from '../../../../__tests__/test-utils/device-fixtures.ts';
import { openIosDevice } from '../app-launch.ts';
import { markSimulatorBooted } from '../simulator.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';

test('openIosDevice spawns nothing when the booted memo was just seeded', async () => {
  markSimulatorBooted(IOS_SIMULATOR);
  const simctlCalls: string[][] = [];
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd, args) => {
      simctlCalls.push([cmd, ...args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    simctl: {
      run: async (args) => {
        simctlCalls.push(['simctl', ...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  await withAppleToolProvider(provider, async () => {
    await openIosDevice(IOS_SIMULATOR);
  });

  assert.deepEqual(simctlCalls, []);
});

test('openIosDevice still boots a simulator that is not observed booted', async () => {
  const coldSimulator = { ...IOS_SIMULATOR, id: 'open-device-cold-sim' };
  let booted = false;
  const provider = createLocalAppleToolProvider({
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    simctl: {
      run: async (args) => {
        if (args.includes('boot')) booted = true;
        if (args.includes('list')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              devices: {
                'iOS 26.2': [{ udid: coldSimulator.id, state: booted ? 'Booted' : 'Shutdown' }],
              },
            }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  await withAppleToolProvider(provider, async () => {
    await openIosDevice(coldSimulator);
  });

  assert.equal(booted, true);
});

test('openIosDevice leaves the macOS desktop target alone', async () => {
  const simctlCalls: string[][] = [];
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args) => {
        simctlCalls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  await withAppleToolProvider(provider, async () => {
    await openIosDevice(MACOS_DEVICE);
  });

  assert.equal(simctlCalls.length, 0);
});
