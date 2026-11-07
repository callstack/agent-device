import assert from 'node:assert/strict';

import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { type AndroidAdbRead, createAdbRead } from './device-evidence.ts';
import type { LiveContext } from './live-harness.ts';

const IME_WINDOW_TIMEOUT_MS = 10_000;
const IME_WINDOW_POLL_MS = 250;

const IME_WINDOW_HEADER = /^\s*Window #\d+ Window\{[0-9a-f]+ u\d+ InputMethod\}:/;
const ANY_WINDOW_HEADER = /^\s*Window #\d+ Window\{/;

/**
 * Whether the InputMethod window has a drawn surface. `mInputShown` flips when the show request is
 * accepted, before the keyboard is painted, and `keyboard dismiss` reports hidden before the hide
 * animation has removed the surface. A screenshot is only comparable once this settles.
 */
export function isImeWindowDrawn(windowDump: string): boolean {
  const lines = windowDump.split('\n');
  const start = lines.findIndex((line) => IME_WINDOW_HEADER.test(line));
  if (start === -1) return false;
  const next = lines.findIndex((line, index) => index > start && ANY_WINDOW_HEADER.test(line));
  const block = lines.slice(start, next === -1 ? undefined : next).join('\n');
  return /\bisReadyForDisplay\(\)=true\b/.test(block) && /\bmDrawState=HAS_DRAWN\b/.test(block);
}

export async function waitForImeWindow(
  context: LiveContext,
  drawn: boolean,
  failure: string,
  read: AndroidAdbRead = createAdbRead(),
): Promise<void> {
  const argv = deviceShellArgv(
    'adb',
    'shell',
    ['dumpsys', 'window', 'windows'],
    ['-s', context.serial],
  );
  const deadline = Date.now() + IME_WINDOW_TIMEOUT_MS;
  do {
    if (isImeWindowDrawn(await read(argv)) === drawn) return;
    await new Promise((resolve) => setTimeout(resolve, IME_WINDOW_POLL_MS));
  } while (Date.now() < deadline);
  assert.fail(`${failure} within ${IME_WINDOW_TIMEOUT_MS}ms`);
}
