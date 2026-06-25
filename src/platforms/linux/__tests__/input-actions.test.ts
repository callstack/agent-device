import { afterAll, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(), whichCmd: vi.fn() };
});

import { runCmd, whichCmd } from '../../../utils/exec.ts';
import { resetInputToolCache } from '../linux-env.ts';
import { pressLinux, scrollLinux, typeLinux, sendKey } from '../input-actions.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockWhichCmd = vi.mocked(whichCmd);

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

function setupXdotool(): void {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env['XDG_SESSION_TYPE'] = 'x11';
  delete process.env['WAYLAND_DISPLAY'];
  resetInputToolCache();
  mockWhichCmd.mockImplementation(async (cmd) => cmd === 'xdotool');
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
}

function setupYdotool(): void {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env['XDG_SESSION_TYPE'] = 'wayland';
  process.env['WAYLAND_DISPLAY'] = 'wayland-0';
  resetInputToolCache();
  mockWhichCmd.mockImplementation(async (cmd) => cmd === 'ydotool');
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
}

/** Extract the [command, args] pairs from all runCmd calls. */
function calls(): Array<[string, string[]]> {
  return mockRunCmd.mock.calls.map((c) => [c[0], c[1] as string[]]);
}

beforeEach(() => {
  mockRunCmd.mockReset();
  mockWhichCmd.mockReset();
  resetInputToolCache();
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  Object.assign(process.env, originalEnv);
});

// ── xdotool tests ────────────────────────────────────────────────────────

test('typeLinux omits --delay when delayMs is 0', async () => {
  setupXdotool();
  await typeLinux('test', 0);
  const c = calls();
  const typeCall = c.find(([cmd, args]) => cmd === 'xdotool' && args.includes('type'));
  assert.ok(typeCall);
  assert.ok(!typeCall[1].includes('--delay'));
});

test('scrollLinux preserves xdotool repeat count for non-paced scroll', async () => {
  setupXdotool();
  await scrollLinux('down', { pixels: 75 });
  const c = calls();
  assert.ok(
    c.some(
      ([cmd, args]) =>
        cmd === 'xdotool' &&
        args.includes('click') &&
        args.includes('--repeat') &&
        args.includes('5'),
    ),
  );
});

// ── ydotool tests ────────────────────────────────────────────────────────

test('pressLinux uses ydotool mousemove + click on Wayland', async () => {
  setupYdotool();
  await pressLinux(100, 200);
  const c = calls();
  assert.ok(
    c.some(
      ([cmd, args]) =>
        cmd === 'ydotool' && args.includes('mousemove') && args.includes('--absolute'),
    ),
  );
  assert.ok(
    c.some(([cmd, args]) => cmd === 'ydotool' && args.includes('click') && args.includes('0xC0')),
  );
});

test('sendKey uses ydotool with scancodes', async () => {
  setupYdotool();
  await sendKey('alt+Left', ['56:1', '105:1', '105:0', '56:0']);
  const c = calls();
  assert.ok(
    c.some(([cmd, args]) => cmd === 'ydotool' && args.includes('key') && args.includes('56:1')),
  );
});

test('typeLinux uses ydotool type', async () => {
  setupYdotool();
  await typeLinux('hello');
  const c = calls();
  assert.ok(
    c.some(([cmd, args]) => cmd === 'ydotool' && args.includes('type') && args.includes('hello')),
  );
});

test('scrollLinux uses ydotool mousemove --wheel for vertical scroll', async () => {
  setupYdotool();
  const result = await scrollLinux('up', { pixels: 80, durationMs: 1 });
  const c = calls();
  assert.ok(
    c.some(
      ([cmd, args]) =>
        cmd === 'ydotool' &&
        args.includes('mousemove') &&
        args.includes('--wheel') &&
        args.includes('-y'),
    ),
  );
  assert.equal(result.durationMs, 1);
});
