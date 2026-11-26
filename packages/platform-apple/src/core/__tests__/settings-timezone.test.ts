import { expect, test } from 'vitest';

import { setIosSetting } from '../app-settings.ts';
import { withFakeAppleTool, type FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

const BOOTED_SIM_LIST_JSON = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'sim-1', state: 'Booted' }] },
});

/** A simulator's launchd environment, driven through `simctl spawn`. */
function simulator(initial: { tz?: string } = {}) {
  let tz = initial.tz ?? '';
  return (args: string[]): FakeAppleToolResponse => {
    if (args[0] === 'simctl' && args.includes('list')) return BOOTED_SIM_LIST_JSON;
    const spawned = args.join(' ').replace(/^simctl spawn sim-1 /, '');
    if (spawned === 'launchctl getenv TZ') return `${tz}\n`;
    const setenv = /^launchctl setenv TZ (\S+)$/.exec(spawned);
    if (setenv || spawned === 'launchctl unsetenv TZ') {
      tz = setenv?.[1] ?? '';
      return '';
    }
    return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
  };
}

function spawnedWrites(calls: string[][]): string[] {
  return calls
    .filter((args) => args[1] === 'spawn')
    .map((args) => args.slice(3).join(' '))
    .filter((call) => !call.includes('getenv'));
}

async function set(state: string) {
  return await setIosSetting(IOS_TEST_SIMULATOR, 'timezone', state, undefined, undefined, {});
}

test('settings timezone sets TZ in the simulator launchd and reset unsets it', async () => {
  await withFakeAppleTool(simulator(), async ({ calls }) => {
    expect(await set('Asia/Kolkata')).toMatchObject({
      timeZone: 'Asia/Kolkata',
      previousTimeZone: null,
      warnings: [expect.stringContaining('relaunch')],
    });
    expect(await set('reset')).toMatchObject({
      timeZone: null,
      previousTimeZone: 'Asia/Kolkata',
    });
    expect(spawnedWrites(calls)).toEqual([
      'launchctl setenv TZ Asia/Kolkata',
      'launchctl unsetenv TZ',
    ]);
  });
});

test('a failed launchctl setenv fails the setting with the simctl output', async () => {
  const script = (args: string[]): FakeAppleToolResponse =>
    args.includes('setenv') ? { stderr: 'launchd unavailable', exitCode: 1 } : simulator()(args);
  await withFakeAppleTool(script, async () => {
    await expect(set('Asia/Kolkata')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { stderr: 'launchd unavailable' },
    });
  });
});
