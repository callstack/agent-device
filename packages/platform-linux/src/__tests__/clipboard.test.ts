import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createLinuxHostStub, type LinuxHostStub } from '../toolbox.fixtures.ts';
import { createLinuxToolProvider } from '../tool-provider.ts';
import { readLinuxClipboard, writeLinuxClipboard } from '../clipboard.ts';
import { AppError } from '@agent-device/kernel/errors';

function stubFor(display: 'x11' | 'wayland', tools: readonly string[]): LinuxHostStub {
  return createLinuxHostStub({
    env: {
      PATH: '/usr/bin',
      XDG_SESSION_TYPE: display,
      ...(display === 'wayland' ? { WAYLAND_DISPLAY: 'wayland-0' } : {}),
    },
    tools,
    respond: () => ({ stdout: display === 'wayland' ? 'wayland content' : 'clipboard content' }),
  });
}

/** wl-clipboard installs `wl-paste` and `wl-copy` together, and the family probes for the pair. */
const WAYLAND_CLIPBOARD = ['wl-paste', 'wl-copy'];

// ── X11 ──────────────────────────────────────────────────────────────────

test('readLinuxClipboard uses xclip on X11', async () => {
  const stub = stubFor('x11', ['xclip']);

  assert.equal(
    await readLinuxClipboard(createLinuxToolProvider(stub.toolbox)),
    'clipboard content',
  );
  const command = stub.commands[0]!;
  assert.equal(command.executable, 'xclip');
  assert.deepEqual(command.args, ['-selection', 'clipboard', '-o']);
  assert.equal(command.allowFailure, true);
});

test('readLinuxClipboard falls back to xsel on X11', async () => {
  const stub = stubFor('x11', ['xsel']);

  assert.equal(
    await readLinuxClipboard(createLinuxToolProvider(stub.toolbox)),
    'clipboard content',
  );
  assert.equal(stub.commands[0]?.executable, 'xsel');
});

test('writeLinuxClipboard pipes the text to xclip on X11', async () => {
  const stub = stubFor('x11', ['xclip']);

  await writeLinuxClipboard(createLinuxToolProvider(stub.toolbox), 'hello');

  const command = stub.commands[0]!;
  assert.equal(command.executable, 'xclip');
  assert.equal(command.stdin, 'hello');
});

test('readLinuxClipboard refuses with TOOL_MISSING when X11 has no clipboard tool', async () => {
  const stub = stubFor('x11', []);

  await assert.rejects(
    () => readLinuxClipboard(createLinuxToolProvider(stub.toolbox)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'TOOL_MISSING');
      assert.match(error.message, /xclip/);
      return true;
    },
  );
  assert.deepEqual(stub.commands, []);
});

// ── Wayland ──────────────────────────────────────────────────────────────

test('readLinuxClipboard uses wl-paste on Wayland', async () => {
  const stub = stubFor('wayland', WAYLAND_CLIPBOARD);

  assert.equal(await readLinuxClipboard(createLinuxToolProvider(stub.toolbox)), 'wayland content');
  assert.equal(stub.commands[0]?.executable, 'wl-paste');
  assert.deepEqual(stub.commands[0]?.args, ['--no-newline']);
});

test('writeLinuxClipboard uses wl-copy on Wayland', async () => {
  const stub = stubFor('wayland', WAYLAND_CLIPBOARD);

  await writeLinuxClipboard(createLinuxToolProvider(stub.toolbox), 'copied');

  const command = stub.commands[0]!;
  assert.equal(command.executable, 'wl-copy');
  assert.deepEqual(command.args, ['--', 'copied']);
});

test('readLinuxClipboard refuses with TOOL_MISSING when Wayland has no clipboard tool', async () => {
  const stub = stubFor('wayland', []);

  await assert.rejects(
    () => readLinuxClipboard(createLinuxToolProvider(stub.toolbox)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'TOOL_MISSING');
      assert.match(error.message, /wl-paste/);
      return true;
    },
  );
});
