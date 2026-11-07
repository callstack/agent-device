import { expect, test } from 'vitest';

import { isImeWindowDrawn } from './live-ime-window.ts';

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

test('a drawn InputMethod window reads as drawn', () => {
  expect(isImeWindowDrawn(`${IME_DRAWN}\n${APP_WINDOW}`)).toBe(true);
});

test('an InputMethod window that is last in the dump reads as drawn', () => {
  expect(isImeWindowDrawn(`${APP_WINDOW}\n${IME_DRAWN}`)).toBe(true);
});

test('a removed InputMethod window reads as not drawn even when the app window below it is drawn', () => {
  expect(isImeWindowDrawn(`${IME_REMOVED}\n${APP_WINDOW}`)).toBe(false);
});

test('an InputMethod window still waiting for its first draw reads as not drawn', () => {
  expect(isImeWindowDrawn(`${IME_SHOW_REQUESTED}\n${APP_WINDOW}`)).toBe(false);
});

test('a dump without an InputMethod window reads as not drawn', () => {
  expect(isImeWindowDrawn(APP_WINDOW)).toBe(false);
});
