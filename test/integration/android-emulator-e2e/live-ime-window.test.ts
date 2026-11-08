import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { readImeWindowState, waitForImeWindow } from './live-ime-window.ts';

const APP_WINDOW = [
  '  Window #7 Window{9a1c2b3 u0 com.callstack.agentdevicelab/com.callstack.agentdevicelab.MainActivity}:',
  '    mViewVisibility=0x0 mHaveFrame=true mObscured=false',
  '    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false',
  '      Surface: shown=true      mDrawState=HAS_DRAWN       mLastHidden=false',
].join('\n');

const IME_DRAWN = [
  '  Window #6 Window{c137705 u0 InputMethod}:',
  '    mViewVisibility=0x0 mHaveFrame=true mObscured=false',
  '    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false',
  '      Surface: shown=true      mDrawState=HAS_DRAWN       mLastHidden=false',
].join('\n');

const IME_REMOVED = [
  '  Window #6 Window{c137705 u0 InputMethod}:',
  '    mViewVisibility=0x8 mHaveFrame=true mObscured=false',
  '    mHasSurface=false isReadyForDisplay()=false mWindowRemovalAllowed=false',
  '      mDrawState=NO_SURFACE       mLastHidden=false',
].join('\n');

const IME_SHOW_REQUESTED = [
  '  Window #6 Window{c137705 u0 InputMethod}:',
  '    mViewVisibility=0x0 mHaveFrame=true mObscured=false',
  '    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false',
  '      Surface: shown=true      mDrawState=COMMIT_DRAW_PENDING       mLastHidden=false',
].join('\n');

const DEVICE = { serial: 'emulator-5554' };

test('a drawn InputMethod window reads as drawn', () => {
  expect(readImeWindowState(`${IME_DRAWN}\n${APP_WINDOW}`)).toBe('drawn');
});

test('an InputMethod window that is last in the dump reads as drawn', () => {
  expect(readImeWindowState(`${APP_WINDOW}\n${IME_DRAWN}`)).toBe('drawn');
});

test('a removed InputMethod window reads as not drawn even when the app window below it is drawn', () => {
  expect(readImeWindowState(`${IME_REMOVED}\n${APP_WINDOW}`)).toBe('not-drawn');
});

test('an InputMethod window still waiting for its first draw reads as not drawn', () => {
  expect(readImeWindowState(`${IME_SHOW_REQUESTED}\n${APP_WINDOW}`)).toBe('not-drawn');
});

test('a window dump without an InputMethod window reads as absent', () => {
  expect(readImeWindowState(APP_WINDOW)).toBe('absent');
});

test('output without any window record reads as unreadable, not as absent', () => {
  expect(readImeWindowState("Can't find service: window\n")).toBe('unreadable');
  expect(readImeWindowState('')).toBe('unreadable');
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]).then(([result]) => result);
  await vi.runAllTimersAsync();
  return settled;
}

test('a failed adb read is retried until the InputMethod window reaches the wanted state', async () => {
  const reads = [
    () => Promise.reject(new Error('adb: device offline')),
    () => Promise.resolve(`${IME_SHOW_REQUESTED}\n${APP_WINDOW}`),
    () => Promise.resolve(`${IME_DRAWN}\n${APP_WINDOW}`),
  ];
  const result = await settle(waitForImeWindow(DEVICE, true, 'never drew', () => reads.shift()!()));

  expect(result.status).toBe('fulfilled');
  expect(reads).toHaveLength(0);
});

test('a wait whose adb reads keep failing reports the last read error at the deadline', async () => {
  const result = await settle(
    waitForImeWindow(DEVICE, true, 'never drew', () =>
      Promise.reject(new Error('adb: device offline')),
    ),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: { message: expect.stringMatching(/never drew within 10000ms.*adb: device offline/s) },
  });
});

test('a hidden wait passes once the InputMethod window record is gone from a window dump', async () => {
  const result = await settle(
    waitForImeWindow(DEVICE, false, 'still drawn', () => Promise.resolve(APP_WINDOW)),
  );

  expect(result.status).toBe('fulfilled');
});

test('a hidden wait keeps polling while the InputMethod window is still drawn', async () => {
  const reads = [
    () => Promise.resolve(`${IME_DRAWN}\n${APP_WINDOW}`),
    () => Promise.resolve(`${IME_DRAWN}\n${APP_WINDOW}`),
    () => Promise.resolve(APP_WINDOW),
  ];
  const result = await settle(
    waitForImeWindow(DEVICE, false, 'still drawn', () => reads.shift()!()),
  );

  expect(result.status).toBe('fulfilled');
  expect(reads).toHaveLength(0);
});

test('a hidden wait never satisfied by unreadable dumps fails with a dump excerpt', async () => {
  const result = await settle(
    waitForImeWindow(DEVICE, false, 'still drawn', () =>
      Promise.resolve("Can't find service: window\n"),
    ),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /still drawn within 10000ms.*no window records.*Can't find service/s,
      ),
    },
  });
});

test('a visible wait never satisfied by a dump without an InputMethod window fails with a dump excerpt', async () => {
  const result = await settle(
    waitForImeWindow(DEVICE, true, 'never drew', () => Promise.resolve(APP_WINDOW)),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /never drew within 10000ms.*no InputMethod window.*Window #7/s,
      ),
    },
  });
});

test('no adb read outlives the wait deadline', async () => {
  const start = Date.now();
  let failedAt = 0;
  const result = await settle(
    waitForImeWindow(DEVICE, true, 'never drew', (_argv, options) => {
      return new Promise((_resolve, reject) =>
        setTimeout(() => {
          failedAt = Date.now();
          reject(new Error('timed out'));
        }, options?.timeoutMs ?? 60_000),
      );
    }),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: { message: expect.stringMatching(/never drew within 10000ms.*timed out/s) },
  });
  expect(failedAt - start).toBeLessThanOrEqual(10_000);
});
