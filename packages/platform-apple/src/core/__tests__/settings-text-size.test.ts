import { test } from 'vitest';
import assert from 'node:assert/strict';

import { readIosSetting, setIosSetting } from '../app-settings.ts';
import { assertRejectsAppError } from '../../__tests__/app-error.ts';
import { withFakeAppleTool, type FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

// `simctl ui <device> content_size` is reached through the production tool-provider scope that
// `withFakeAppleTool` installs, so nothing here shells out for real.

const BOOTED_SIM_LIST_JSON = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'sim-1', state: 'Booted' }] },
});

function isSimctlListDevices(args: string[]): boolean {
  return (
    args[0] === 'simctl' && args.includes('list') && args.includes('devices') && args.includes('-j')
  );
}

function unexpectedArgs(args: string[]): FakeAppleToolResponse {
  return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
}

function simctlUiCalls(calls: string[][]): string[] {
  return calls
    .filter((args) => args[0] === 'simctl' && args[1] === 'ui')
    .map((args) => args.join(' '));
}

test('setIosSetting text-size applies the category with simctl ui content_size', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl ui sim-1 content_size accessibility-extra-large') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      const result = await setIosSetting(
        IOS_TEST_SIMULATOR,
        'text-size',
        'accessibility-extra-large',
      );
      assert.deepEqual(result, {
        setting: 'text-size',
        category: 'accessibility-extra-large',
        platformValue: 'accessibility-extra-large',
      });
      assert.deepEqual(simctlUiCalls(calls), [
        'simctl ui sim-1 content_size accessibility-extra-large',
      ]);
    },
  );
});

test('setIosSetting text-size sends the normalized category, not the caller casing', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl ui sim-1 content_size extra-small') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'text-size', ' Extra-Small ');
      assert.deepEqual(simctlUiCalls(calls), ['simctl ui sim-1 content_size extra-small']);
    },
  );
});

test('setIosSetting text-size refuses an off-ladder category without calling simctl', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      // `simctl ui ... content_size bogus` exits 0 with `Invalid argument`, so an unvalidated write
      // would be reported as a successful change that changed nothing.
      await assertRejectsAppError(
        () => setIosSetting(IOS_TEST_SIMULATOR, 'text-size', 'gigantic'),
        {
          code: 'INVALID_ARGS',
        },
      );
      assert.deepEqual(simctlUiCalls(calls), []);
    },
  );
});

test('readIosSetting text-size reports the category and the value the simulator answered with', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl ui sim-1 content_size') return 'extra-extra-large\n';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      const result = await readIosSetting(IOS_TEST_SIMULATOR, 'text-size');
      assert.deepEqual(result, {
        setting: 'text-size',
        category: 'extra-extra-large',
        platformValue: 'extra-extra-large',
      });
      assert.deepEqual(simctlUiCalls(calls), ['simctl ui sim-1 content_size']);
    },
  );
});

test('readIosSetting text-size normalizes the echo while keeping what the tool reported', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      // Observed live: writing `extra-small` and `small` makes simctl answer `extra-Small`/`Small`.
      if (args.join(' ') === 'simctl ui sim-1 content_size') return 'extra-Small';
      return unexpectedArgs(args);
    },
    async () => {
      const result = await readIosSetting(IOS_TEST_SIMULATOR, 'text-size');
      assert.deepEqual(result, {
        setting: 'text-size',
        category: 'extra-small',
        platformValue: 'extra-Small',
      });
    },
  );
});

test('readIosSetting text-size fails on a value the ladder does not name', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      // Observed live: an unbooted simulator answers `unknown`.
      if (args.join(' ') === 'simctl ui sim-1 content_size') return 'unknown';
      return unexpectedArgs(args);
    },
    async () => {
      await assertRejectsAppError(() => readIosSetting(IOS_TEST_SIMULATOR, 'text-size'), {
        code: 'COMMAND_FAILED',
        message: /unknown text size: unknown/,
      });
    },
  );
});

test('readIosSetting text-size reports a failing simctl read', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl ui sim-1 content_size')
        return { stderr: 'Invalid argument', exitCode: 1 };
      return unexpectedArgs(args);
    },
    async () => {
      await assertRejectsAppError(() => readIosSetting(IOS_TEST_SIMULATOR, 'text-size'), {
        code: 'COMMAND_FAILED',
      });
    },
  );
});
