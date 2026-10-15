import { expect, test } from 'vitest';
import { validateOpenRelaunchTarget } from './platform-runtime-open-target.ts';

const INSTALLED_PACKAGE_REQUIRED = (target: string) =>
  `Android runtime hints require an installed package name, not "${target}". Install or reinstall the app first, then relaunch by package.`;

test('open --relaunch refuses URL targets', async () => {
  expect(
    await validateOpenRelaunchTarget({ target: 'https://example.com/path', platform: undefined }),
  ).toMatch(/does not support URL targets/i);
});

test.each(['/tmp/app-debug.apk', 'app-debug.apk'])(
  'open --relaunch refuses the Android app binary target %s',
  async (target) => {
    expect(await validateOpenRelaunchTarget({ target, platform: 'android' })).toBe(
      INSTALLED_PACKAGE_REQUIRED(target),
    );
  },
);

test('open --relaunch accepts an installed Android package name', async () => {
  expect(
    await validateOpenRelaunchTarget({ target: 'com.example.app', platform: 'android' }),
  ).toBeUndefined();
});
