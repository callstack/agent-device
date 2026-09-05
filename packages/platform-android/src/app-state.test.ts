import { expect, test } from 'vitest';
import { parseAndroidForegroundApp, readAndroidAppStateWithExecutor } from './app-state.ts';

test('parses Android window and activity foreground markers', () => {
  expect(
    parseAndroidForegroundApp('mCurrentFocus=Window{1 u0 com.example.application/.MainActivity}'),
  ).toEqual({ package: 'com.example.application', activity: '.MainActivity' });
  expect(
    parseAndroidForegroundApp('mResumedActivity: ActivityRecord{u0 com.example.application/.Home}'),
  ).toEqual({ package: 'com.example.application', activity: '.Home' });
});

test('keeps window-focus precedence when multiple markers are present', () => {
  expect(
    parseAndroidForegroundApp(
      'mResumedActivity: ActivityRecord{u0 com.example.application/.Activity}\n' +
        'mCurrentFocus=Window{1 u0 com.example.application/.Window}',
    ),
  ).toEqual({ package: 'com.example.application', activity: '.Window' });
});

test('returns no app for output without a recognized focus marker', () => {
  expect(parseAndroidForegroundApp('mCurrentFocus=Window{1 u0 StatusBar}')).toBeNull();
});

test('scans repeated uncontrolled focus text without regular-expression backtracking', () => {
  expect(
    parseAndroidForegroundApp(`ResumedActivity:${'ResumedActivity:a'.repeat(20_000)}`),
  ).toBeNull();
});

test('stops between dumpsys attempts once the request is aborted', async () => {
  const controller = new AbortController();
  const issued: string[][] = [];
  const run = async (args: string[]) => {
    issued.push(args);
    controller.abort(new Error('request canceled'));
    return { exitCode: 0, stdout: 'mCurrentFocus=Window{1 u0 StatusBar}', stderr: '' };
  };

  await expect(readAndroidAppStateWithExecutor(run, controller.signal)).rejects.toThrow(
    'request canceled',
  );
  expect(issued).toEqual([['shell', 'dumpsys', 'window', 'windows']]);
});
