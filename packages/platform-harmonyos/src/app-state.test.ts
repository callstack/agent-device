import { expect, test } from 'vitest';
import { parseHarmonyForegroundApp } from './app-state.ts';

test('parses the foreground ability from the mission list', () => {
  expect(
    parseHarmonyForegroundApp(`
      Mission ID #57  mission name #[#com.huawei.hmos.settings:phone_settings:com.huawei.hmos.settings.MainAbility]
        state #BACKGROUND
      Mission ID #76  mission name #[#com.example.application:entry:EntryAbility]
        state #FOREGROUND
    `),
  ).toEqual({ package: 'com.example.application', activity: 'EntryAbility' });
});

test('rejects a mission list without a foreground ability', () => {
  expect(parseHarmonyForegroundApp('Mission ID #57 state #BACKGROUND')).toBeUndefined();
});
