import { afterAll, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { bindTestCommandHost } from '@agent-device/test-kit';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(), whichCmd: vi.fn() };
});

import { runCmd, whichCmd } from '@agent-device/host-kit/command';
import { createLinuxInteractor } from '../interactor.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

bindTestCommandHost();

// Two composing runtimes drive the plain local provider through their own hosts. Each interactor
// resolves its display decision from its own provider: A(X11) → B(Wayland) → A answers
// xdotool → ydotool → xdotool, against a process environment that claims Wayland for everyone.
// The old ambient decision answered host A's X11 for host B (#3794).

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

const mockRunCmd = vi.mocked(runCmd);
const mockWhichCmd = vi.mocked(whichCmd);

function hostWithEnv(env: Record<string, string | undefined>): HostEnvironment {
  return { env: { ...process.env, ...env }, cwd: process.cwd() };
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  // The process environment claims a Wayland session for the whole machine; neither host names
  // this display, so any answer read from the process instead of the runtime host is wrong here.
  process.env['WAYLAND_DISPLAY'] = 'wayland-9';
  process.env['XDG_SESSION_TYPE'] = 'wayland';
  mockRunCmd.mockReset();
  mockWhichCmd.mockReset();
  mockWhichCmd.mockImplementation(async (cmd) => cmd === 'xdotool' || cmd === 'ydotool');
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function synthesisCommands(): string[] {
  return mockRunCmd.mock.calls
    .map(([cmd, args]) => ({ cmd, first: (args as string[])[0] }))
    .filter(({ cmd, first }) => cmd !== 'xdotool' || first !== 'getmouselocation')
    .map(({ cmd }) => cmd);
}

test('interactors on different hosts resolve input through their own host display', async () => {
  const hostA = hostWithEnv({ WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: 'x11' });
  const hostB = hostWithEnv({ WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: 'wayland' });
  const interactorA = createLinuxInteractor(hostA);
  const interactorB = createLinuxInteractor(hostB);

  // Phase A: the X11 host resolves xdotool from its own host env.
  await interactorA.tap!(1, 2);
  assert.deepEqual(synthesisCommands(), ['xdotool', 'xdotool']);

  // Phase B: the Wayland host must resolve ydotool even though A resolved xdotool first. The
  // old ambient decision answered host A's X11 here, against B's own host.
  mockRunCmd.mockClear();
  await interactorB.tap!(3, 4);
  assert.deepEqual(
    mockRunCmd.mock.calls.map(([cmd, args]) => [cmd, ...(args as string[])]),
    [
      ['ydotool', 'mousemove', '--absolute', '-x', '3', '-y', '4'],
      ['ydotool', 'click', '0xC0'],
    ],
  );

  // Phase A again: B's Wayland answer never leaked into A's provider.
  mockRunCmd.mockClear();
  await interactorA.tap!(5, 6);
  assert.deepEqual(synthesisCommands(), ['xdotool', 'xdotool']);
});
