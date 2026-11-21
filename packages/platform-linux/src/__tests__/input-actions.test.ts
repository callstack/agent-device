import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createLinuxHostStub, type LinuxHostStub } from '../toolbox.fixtures.ts';
import { createLinuxToolProvider } from '../tool-provider.ts';
import { fillLinux, pressLinux, scrollLinux, sendKey, typeLinux } from '../input-actions.ts';
import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';
import { AppError } from '@agent-device/kernel/errors';

function x11Stub(): LinuxHostStub {
  return createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools: ['xdotool'],
    respond: () => ({}),
  });
}

function waylandStub(): LinuxHostStub {
  return createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
    tools: ['ydotool'],
    respond: () => ({}),
  });
}

function calls(stub: LinuxHostStub): Array<[string, readonly string[]]> {
  return stub.commands.map((c) => [c.executable, c.args]);
}

function providerOf(stub: LinuxHostStub): LinuxToolProvider {
  return createLinuxToolProvider(stub.toolbox);
}

// ── xdotool ──────────────────────────────────────────────────────────────

test('typeLinux omits --delay when delayMs is 0', async () => {
  const stub = x11Stub();
  await typeLinux(providerOf(stub), 'test', 0);

  const typeCall = calls(stub).find(
    ([cmd, args]) => cmd === 'xdotool' && (args as string[]).includes('type'),
  );
  assert.ok(typeCall);
  assert.equal((typeCall[1] as string[]).includes('--delay'), false);
});

// `fill <target> ""` is the clear-field primitive (#2063). Typing zero characters over the
// Ctrl+A selection leaves the old value selected but intact, so the empty fill must delete
// the selection instead.
test('fillLinux deletes the select-all selection for an empty text', async () => {
  const stub = x11Stub();
  await fillLinux(providerOf(stub), 10, 20, '');

  const args = calls(stub).map(([, a]) => a as string[]);
  assert.ok(args.some((a) => a.includes('BackSpace')));
  assert.equal(args.some((a) => a.includes('type')), false);
});

test('scrollLinux preserves the xdotool repeat count for non-paced scroll', async () => {
  const stub = x11Stub();
  await scrollLinux(providerOf(stub), 'down', { pixels: 75 });

  assert.ok(
    calls(stub).some(
      ([cmd, args]) =>
        cmd === 'xdotool' &&
        (args as string[]).includes('click') &&
        (args as string[]).includes('--repeat') &&
        (args as string[]).includes('5'),
    ),
  );
});

// ── ydotool ──────────────────────────────────────────────────────────────

test('pressLinux uses ydotool mousemove and click on Wayland', async () => {
  const stub = waylandStub();
  await pressLinux(providerOf(stub), 100, 200);

  const args = calls(stub).map(([, a]) => a as string[]);
  assert.ok(args.some((a) => a.includes('mousemove') && a.includes('--absolute')));
  assert.ok(args.some((a) => a.includes('click') && a.includes('0xC0')));
});

test('sendKey uses ydotool with scancodes', async () => {
  const stub = waylandStub();
  await sendKey(providerOf(stub), 'alt+Left', ['56:1', '105:1', '105:0', '56:0']);

  assert.ok(
    calls(stub).some(
      ([cmd, args]) => cmd === 'ydotool' && (args as string[]).includes('key') && (args as string[]).includes('56:1'),
    ),
  );
});

test('typeLinux uses ydotool type', async () => {
  const stub = waylandStub();
  await typeLinux(providerOf(stub), 'hello');

  assert.ok(
    calls(stub).some(
      ([cmd, args]) => cmd === 'ydotool' && (args as string[]).includes('type') && (args as string[]).includes('hello'),
    ),
  );
});

test('scrollLinux uses ydotool mousemove --wheel for vertical scroll', async () => {
  const stub = waylandStub();
  const result = await scrollLinux(providerOf(stub), 'up', { pixels: 80, durationMs: 1 });

  assert.ok(
    calls(stub).some(
      ([cmd, args]) =>
        cmd === 'ydotool' &&
        (args as string[]).includes('mousemove') &&
        (args as string[]).includes('--wheel') &&
        (args as string[]).includes('-y'),
    ),
  );
  assert.equal(result.durationMs, 1);
});

test('input synthesis refuses with TOOL_MISSING when the host has no tool for the display', async () => {
  const stub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools: [],
  });

  await assert.rejects(
    () => pressLinux(providerOf(stub), 1, 2),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'TOOL_MISSING');
      assert.match(error.message, /xdotool/);
      return true;
    },
  );
  assert.deepEqual(stub.commands, []);
});
