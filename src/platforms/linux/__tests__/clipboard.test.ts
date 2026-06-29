import { afterAll, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(), whichCmd: vi.fn() };
});

import { runCmd, whichCmd } from '../../../utils/exec.ts';
import { readLinuxClipboard, writeLinuxClipboard } from '../clipboard.ts';
import { AppError } from '../../../kernel/errors.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockWhichCmd = vi.mocked(whichCmd);

const originalEnv = { ...process.env };

function setupX11(): void {
  process.env['XDG_SESSION_TYPE'] = 'x11';
  delete process.env['WAYLAND_DISPLAY'];
}

function setupWayland(): void {
  process.env['XDG_SESSION_TYPE'] = 'wayland';
  process.env['WAYLAND_DISPLAY'] = 'wayland-0';
}

beforeEach(() => {
  mockRunCmd.mockReset();
  mockWhichCmd.mockReset();
});

afterAll(() => {
  Object.assign(process.env, originalEnv);
});

// ── X11 clipboard ────────────────────────────────────────────────────────

test('readLinuxClipboard uses xclip on X11', async () => {
  setupX11();
  mockWhichCmd.mockImplementation(async (cmd) => cmd === 'xclip');
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: 'clipboard content', stderr: '' });

  const result = await readLinuxClipboard();
  assert.equal(result, 'clipboard content');
  assert.equal(mockRunCmd.mock.calls[0]![0], 'xclip');
  assert.ok((mockRunCmd.mock.calls[0]![1] as string[]).includes('-o'));
});

test('readLinuxClipboard falls back to xsel on X11', async () => {
  setupX11();
  mockWhichCmd.mockImplementation(async (cmd) => cmd === 'xsel');
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: 'from xsel', stderr: '' });

  const result = await readLinuxClipboard();
  assert.equal(result, 'from xsel');
  assert.equal(mockRunCmd.mock.calls[0]![0], 'xsel');
});

test('writeLinuxClipboard uses xclip with stdin on X11', async () => {
  setupX11();
  mockWhichCmd.mockImplementation(async (cmd) => cmd === 'xclip');
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

  await writeLinuxClipboard('hello');
  assert.equal(mockRunCmd.mock.calls[0]![0], 'xclip');
  assert.equal((mockRunCmd.mock.calls[0]![2] as Record<string, unknown>).stdin, 'hello');
});

test('readLinuxClipboard throws TOOL_MISSING when no tool on X11', async () => {
  setupX11();
  mockWhichCmd.mockResolvedValue(false);

  await assert.rejects(
    () => readLinuxClipboard(),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'TOOL_MISSING');
      assert.ok(err.message.includes('xclip'));
      return true;
    },
  );
});

// ── Wayland clipboard ────────────────────────────────────────────────────

test('readLinuxClipboard uses wl-paste on Wayland', async () => {
  setupWayland();
  mockWhichCmd.mockImplementation(async (cmd) => cmd === 'wl-paste');
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: 'wayland content', stderr: '' });

  const result = await readLinuxClipboard();
  assert.equal(result, 'wayland content');
  assert.equal(mockRunCmd.mock.calls[0]![0], 'wl-paste');
});

test('writeLinuxClipboard uses wl-copy on Wayland', async () => {
  setupWayland();
  mockWhichCmd.mockImplementation(async (cmd) => cmd === 'wl-copy' || cmd === 'wl-paste');
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

  await writeLinuxClipboard('copied');
  assert.equal(mockRunCmd.mock.calls[0]![0], 'wl-copy');
  assert.ok((mockRunCmd.mock.calls[0]![1] as string[]).includes('copied'));
});

test('readLinuxClipboard throws TOOL_MISSING when no tool on Wayland', async () => {
  setupWayland();
  mockWhichCmd.mockResolvedValue(false);

  await assert.rejects(
    () => readLinuxClipboard(),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'TOOL_MISSING');
      assert.ok(err.message.includes('wl-paste'));
      return true;
    },
  );
});
