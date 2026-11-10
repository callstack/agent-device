import assert from 'node:assert/strict';

import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { type AndroidAdbRead, createAdbRead } from './device-evidence.ts';
import type { LiveContext } from './live-harness.ts';

const IME_WINDOW_TIMEOUT_MS = 10_000;
const IME_WINDOW_POLL_MS = 250;
const IME_WINDOW_READ_TIMEOUT_MS = 5_000;
const DUMP_EXCERPT_LENGTH = 400;

const IME_WINDOW_HEADER = /^\s*Window #\d+ Window\{[0-9a-f]+ u\d+ InputMethod\}:/;
const ANY_WINDOW_HEADER = /^\s*Window #\d+ Window\{/;

type ImeWindowState = 'drawn' | 'not-drawn' | 'absent' | 'unreadable';

/**
 * Whether the InputMethod window has a drawn surface. `mInputShown` flips when the show request is
 * accepted, before the keyboard is painted, and `keyboard dismiss` reports hidden before the hide
 * animation has removed the surface. A screenshot is only comparable once this settles. `absent`
 * means the dump lists windows but no InputMethod window, which Android does after a dismissal.
 * `unreadable` means the output holds no window record at all, so it says nothing about the keyboard.
 */
export function readImeWindowState(windowDump: string): ImeWindowState {
  const lines = windowDump.split('\n');
  const start = lines.findIndex((line) => IME_WINDOW_HEADER.test(line));
  if (start === -1) {
    return lines.some((line) => ANY_WINDOW_HEADER.test(line)) ? 'absent' : 'unreadable';
  }
  const next = lines.findIndex((line, index) => index > start && ANY_WINDOW_HEADER.test(line));
  const block = lines.slice(start, next === -1 ? undefined : next).join('\n');
  return /\bisReadyForDisplay\(\)=true\b/.test(block) && /\bmDrawState=HAS_DRAWN\b/.test(block)
    ? 'drawn'
    : 'not-drawn';
}

export async function waitForImeWindow(
  device: Pick<LiveContext, 'serial'>,
  drawn: boolean,
  failure: string,
  read: AndroidAdbRead = createAdbRead(),
): Promise<void> {
  const argv = deviceShellArgv(
    'adb',
    'shell',
    ['dumpsys', 'window', 'windows'],
    ['-s', device.serial],
  );
  const wanted: readonly ImeWindowState[] = drawn ? ['drawn'] : ['not-drawn', 'absent'];
  const deadline = Date.now() + IME_WINDOW_TIMEOUT_MS;
  let lastObservation = 'no adb read finished';
  for (let remaining = IME_WINDOW_TIMEOUT_MS; remaining > 0; remaining = deadline - Date.now()) {
    try {
      const dump = await read(argv, { timeoutMs: Math.min(remaining, IME_WINDOW_READ_TIMEOUT_MS) });
      const state = readImeWindowState(dump);
      if (wanted.includes(state)) return;
      lastObservation = describeImeWindowState(state, dump);
    } catch (error) {
      lastObservation = `last adb read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const pause = Math.min(IME_WINDOW_POLL_MS, deadline - Date.now());
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  assert.fail(`${failure} within ${IME_WINDOW_TIMEOUT_MS}ms (${lastObservation})`);
}

function describeImeWindowState(state: ImeWindowState, dump: string): string {
  const excerpt = dump.trim().slice(0, DUMP_EXCERPT_LENGTH);
  switch (state) {
    case 'drawn':
    case 'not-drawn':
      return `InputMethod window was ${state}`;
    case 'absent':
      return `no InputMethod window in the dump: ${excerpt}`;
    case 'unreadable':
      return `no window records in the dump: ${excerpt}`;
  }
}
