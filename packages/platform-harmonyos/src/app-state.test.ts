import { expect, test } from 'vitest';
import { parseHarmonyForegroundRead } from './app-state.ts';

test('parses the foreground ability from the mission list', () => {
  expect(
    parseHarmonyForegroundRead(`
      Mission ID #57  mission name #[#com.huawei.hmos.settings:phone_settings:com.huawei.hmos.settings.MainAbility]
        state #BACKGROUND
      Mission ID #76  mission name #[#com.example.application:entry:EntryAbility]
        state #FOREGROUND
    `),
  ).toEqual({ kind: 'foreground', package: 'com.example.application', activity: 'EntryAbility' });
});

test('classifies a mission list without a foreground mission as no-foreground-mission', () => {
  expect(parseHarmonyForegroundRead('Mission ID #57 state #BACKGROUND')).toEqual({
    kind: 'no-foreground-mission',
  });
});

test('classifies output with no mission list as unparseable', () => {
  expect(parseHarmonyForegroundRead('')).toEqual({ kind: 'unparseable' });
  expect(parseHarmonyForegroundRead('aa: error: dump failed')).toEqual({ kind: 'unparseable' });
});

test('classifies a foreground mission whose name did not parse as unparseable', () => {
  expect(
    parseHarmonyForegroundRead(`
      Mission ID #57  mission name #[malformed
        state #FOREGROUND
    `),
  ).toEqual({ kind: 'unparseable' });
});
