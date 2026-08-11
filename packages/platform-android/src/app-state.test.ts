import { expect, test } from 'vitest';
import { parseAndroidForegroundApp } from './app-state.ts';

test('parses Android window and activity foreground markers', () => {
  expect(
    parseAndroidForegroundApp('mCurrentFocus=Window{1 u0 com.example.application/.MainActivity}'),
  ).toEqual({ package: 'com.example.application', activity: '.MainActivity' });
  expect(
    parseAndroidForegroundApp('mResumedActivity: ActivityRecord{u0 com.example.application/.Home}'),
  ).toEqual({ package: 'com.example.application', activity: '.Home' });
});

test('returns no app for output without a recognized focus marker', () => {
  expect(parseAndroidForegroundApp('mCurrentFocus=Window{1 u0 StatusBar}')).toBeNull();
});
