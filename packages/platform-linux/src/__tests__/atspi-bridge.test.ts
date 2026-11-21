import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withMockedPlatform } from '@agent-device/test-kit';
import { createLinuxHostStub, type LinuxHostStub } from '../toolbox.fixtures.ts';
import { createLinuxToolProvider } from '../tool-provider.ts';
import { resolveLinuxAtspiScriptPath } from '../atspi-script.ts';
import { AppError } from '@agent-device/kernel/errors';

/** The AT-SPI2 capture route, answering through the host the plugin was set up with. */
function captureAtspi(
  stub: LinuxHostStub,
  surface: 'desktop' | 'frontmost-app' = 'desktop',
  options: { maxNodes?: number; maxDepth?: number; maxApps?: number; signal?: AbortSignal } = {},
) {
  const provider = createLinuxToolProvider(stub.toolbox);
  return provider.accessibility!.captureTree(surface, options);
}

function stubPython(
  stdout: string,
  answer: Readonly<{ exitCode?: number; stderr?: string }> = {},
): LinuxHostStub {
  return createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools: ['python3'],
    respond: (executable) =>
      executable === 'python3'
        ? { stdout, exitCode: answer.exitCode ?? 0, stderr: answer.stderr ?? '' }
        : {},
  });
}

const TREE = JSON.stringify({
  nodes: [
    {
      index: 0,
      role: 'push button',
      label: 'OK',
      rect: { x: 4, y: 8, width: 40, height: 20 },
      depth: 1,
      parentIndex: 5,
      pid: 411,
      appName: 'Files',
      windowTitle: 'Home',
    },
  ],
  truncated: false,
  surface: 'desktop',
});

test('the AT-SPI capture runs the helper shipped with the plugin', async () => {
  const stub = stubPython(TREE);

  await withMockedPlatform('linux', () => captureAtspi(stub));

  const command = stub.commands[0]!;
  assert.equal(command.executable, 'python3');
  assert.equal(command.args[0], resolveLinuxAtspiScriptPath());
  // The helper has to ship inside the installed package, not resolve against a repository layout.
  assert.equal(path.basename(command.args[0]!), 'atspi-dump.py');
  assert.equal(path.dirname(command.args[0]!).endsWith('linux'), true);
});

test('the AT-SPI capture passes the surface and traversal limits', async () => {
  const stub = stubPython(TREE);

  await withMockedPlatform('linux', () =>
    captureAtspi(stub, 'frontmost-app', { maxNodes: 10, maxDepth: 3, maxApps: 2 }),
  );

  assert.deepEqual(stub.commands[0]!.args.slice(1), [
    '--surface',
    'frontmost-app',
    '--max-nodes',
    '10',
    '--max-depth',
    '3',
    '--max-apps',
    '2',
  ]);
});

test('the AT-SPI capture falls back to the helper defaults and tolerates a non-zero probe answer', async () => {
  const stub = stubPython(TREE);

  await withMockedPlatform('linux', () => captureAtspi(stub));

  const command = stub.commands[0]!;
  assert.deepEqual(command.args.slice(3), [
    '--max-nodes',
    '1500',
    '--max-depth',
    '12',
    '--max-apps',
    '24',
  ]);
  // The helper's own failure answer is read from its exit code, so the run must not throw first.
  assert.equal(command.allowFailure, true);
});

test('the AT-SPI capture maps helper roles through the family role map', async () => {
  const stub = stubPython(TREE);

  const result = await withMockedPlatform('linux', () => captureAtspi(stub));

  assert.deepEqual(result.nodes, [
    {
      index: 0,
      type: 'Button',
      role: 'push button',
      label: 'OK',
      value: undefined,
      rect: { x: 4, y: 8, width: 40, height: 20 },
      enabled: undefined,
      selected: undefined,
      hittable: undefined,
      depth: 1,
      parentIndex: 5,
      pid: 411,
      appName: 'Files',
      windowTitle: 'Home',
    },
  ]);
  assert.equal(result.surface, 'desktop');
  assert.equal(result.truncated, false);
});

test('the AT-SPI capture reports the missing PyGObject bindings as a missing tool', async () => {
  const stub = stubPython('', {
    exitCode: 1,
    stderr: "ModuleNotFoundError: No module named 'gi'",
  });

  await assert.rejects(
    () => withMockedPlatform('linux', () => captureAtspi(stub)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'TOOL_MISSING');
      assert.match(error.message, /python3-gi/);
      return true;
    },
  );
});

test('the AT-SPI capture reports a helper that failed for another reason', async () => {
  const stub = stubPython('', { exitCode: 2, stderr: 'Display :0 not found' });

  await assert.rejects(
    () => withMockedPlatform('linux', () => captureAtspi(stub)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /Display :0 not found/);
      return true;
    },
  );
});

test('the AT-SPI capture reports output it cannot parse', async () => {
  const stub = stubPython('not json');

  await assert.rejects(
    () => withMockedPlatform('linux', () => captureAtspi(stub)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /invalid JSON/);
      return true;
    },
  );
});

test('the AT-SPI capture reports the helper own error answer', async () => {
  const stub = stubPython(
    JSON.stringify({ nodes: [], truncated: false, surface: 'desktop', error: 'no registry' }),
  );

  await assert.rejects(
    () => withMockedPlatform('linux', () => captureAtspi(stub)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /AT-SPI2: no registry/);
      return true;
    },
  );
});

test('the AT-SPI capture asks before spawning when the host has no python3', async () => {
  const stub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools: [],
  });

  await assert.rejects(
    () => withMockedPlatform('linux', () => captureAtspi(stub)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'TOOL_MISSING');
      assert.match(error.message, /python3/);
      return true;
    },
  );
  assert.deepEqual(stub.commands, []);
});

test('the AT-SPI capture refuses off a Linux host without touching it', async () => {
  const stub = stubPython(TREE);

  await assert.rejects(
    () => captureAtspi(stub),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
      return true;
    },
  );
  assert.deepEqual(stub.commands, []);
});
