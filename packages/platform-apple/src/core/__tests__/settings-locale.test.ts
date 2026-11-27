import { expect, test } from 'vitest';

import { setIosSetting } from '../app-settings.ts';
import { withFakeAppleTool, type FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

const BOOTED_SIM_LIST_JSON = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'sim-1', state: 'Booted' }] },
});
const MISSING_KEY = {
  stderr: "Error: Could not find key 'AppleLocale' in domain 'kCFPreferencesAnyApplication'.",
  exitCode: 1,
};

/** The global domain as `defaults export -g -` prints it. */
function exportedDomain(defaults: ReadonlyMap<string, string>): string {
  const entries = [...defaults].map(([key, value]) =>
    key === 'AppleLanguages'
      ? `<key>${key}</key>\n<array>\n${value
          .split(',')
          .map((language) => `<string>${language}</string>`)
          .join('\n')}\n</array>`
      : `<key>${key}</key>\n<string>${value}</string>`,
  );
  return `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n${entries.join('\n')}\n</dict>\n</plist>\n`;
}

/** A simulator's global domain, driven through `simctl spawn`. */
function simulator(initial: { locale?: string } = {}) {
  const defaults = new Map<string, string>();
  if (initial.locale !== undefined) {
    defaults.set('AppleLanguages', 'en-US,en-IN');
    defaults.set('AppleLocale', initial.locale);
  }
  return (args: string[]): FakeAppleToolResponse => {
    if (args[0] === 'simctl' && args.includes('list')) return BOOTED_SIM_LIST_JSON;
    const spawned = args.join(' ').replace(/^simctl spawn sim-1 /, '');
    if (spawned === 'defaults export -g -') return exportedDomain(defaults);
    const write = /^defaults write -g (\w+) -(?:array|string) (\S+)$/.exec(spawned);
    if (write) {
      defaults.set(write[1]!, write[2]!);
      return '';
    }
    const remove = /^defaults delete -g (\w+)$/.exec(spawned);
    if (remove) return defaults.delete(remove[1]!) ? '' : MISSING_KEY;
    return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
  };
}

function spawnedCalls(calls: string[][]): string[] {
  return calls
    .filter((args) => args[1] === 'spawn')
    .map((args) => args.slice(3).join(' '))
    .filter((call) => !call.includes(' export '));
}

async function set(state: string) {
  return await setIosSetting(IOS_TEST_SIMULATOR, 'locale', state, undefined, undefined, {});
}

test('settings locale writes AppleLanguages as a tag and AppleLocale with an underscore', async () => {
  await withFakeAppleTool(simulator({ locale: 'en_US' }), async ({ calls }) => {
    expect(await set('zh-Hans-CN')).toMatchObject({
      locale: 'zh-Hans-CN',
      previousLocale: 'en-US',
      warnings: [expect.stringContaining('relaunch')],
    });
    expect(spawnedCalls(calls)).toEqual([
      'defaults write -g AppleLanguages -array zh-Hans-CN',
      'defaults write -g AppleLocale -string zh-Hans_CN',
    ]);
  });
});

test('settings locale writes a language-only tag without adding an underscore', async () => {
  await withFakeAppleTool(simulator(), async ({ calls }) => {
    expect(await set('en')).toMatchObject({ locale: 'en', previousLocale: null });
    expect(spawnedCalls(calls)).toEqual([
      'defaults write -g AppleLanguages -array en',
      'defaults write -g AppleLocale -string en',
    ]);
  });
});

test('settings locale reset deletes both keys and reports the locale it held', async () => {
  await withFakeAppleTool(simulator({ locale: 'en_US@rg=inzzzz' }), async ({ calls }) => {
    // Foundation's keyword is dropped so the reported locale is one settings locale accepts.
    expect(await set('reset')).toMatchObject({
      locale: null,
      previousLocale: 'en-US',
      previousLanguages: ['en-US', 'en-IN'],
    });
    expect(spawnedCalls(calls)).toEqual([
      'defaults delete -g AppleLanguages',
      'defaults delete -g AppleLocale',
    ]);
  });
});

test('settings locale reset on a simulator that holds no locale deletes nothing', async () => {
  await withFakeAppleTool(simulator(), async ({ calls }) => {
    expect(await set('reset')).toMatchObject({
      locale: null,
      previousLocale: null,
      previousLanguages: null,
    });
    expect(spawnedCalls(calls)).toEqual([]);
  });
});

test('a Foundation locale settings locale cannot take is reported as null', async () => {
  await withFakeAppleTool(simulator({ locale: 'en_US_POSIX' }), async () => {
    expect(await set('fr-FR')).toMatchObject({ locale: 'fr-FR', previousLocale: null });
  });
});

test('a failed defaults write fails the setting with the simctl output', async () => {
  const script = (args: string[]): FakeAppleToolResponse =>
    args.includes('write') ? { stderr: 'cfprefsd unavailable', exitCode: 1 } : simulator()(args);
  await withFakeAppleTool(script, async () => {
    await expect(set('en-IN')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { stderr: 'cfprefsd unavailable' },
    });
  });
});
