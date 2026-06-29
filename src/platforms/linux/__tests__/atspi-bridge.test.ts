import { afterAll, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(), whichCmd: vi.fn() };
});

import { captureAccessibilityTree } from '../atspi-bridge.ts';
import { runCmd, whichCmd } from '../../../utils/exec.ts';
import { AppError } from '../../../kernel/errors.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockWhichCmd = vi.mocked(whichCmd);

// Stub process.platform to 'linux' for these tests
const originalPlatform = process.platform;
beforeEach(() => {
  mockRunCmd.mockReset();
  mockWhichCmd.mockReset();
  mockWhichCmd.mockResolvedValue(true);
  Object.defineProperty(process, 'platform', { value: 'linux' });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

function makePythonResult(nodes: Record<string, unknown>[], truncated = false) {
  return JSON.stringify({ nodes, truncated, surface: 'desktop' });
}

test('parses Python JSON output into RawSnapshotNodes with normalized roles', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: makePythonResult([
      {
        index: 0,
        role: 'push button',
        label: 'OK',
        value: null,
        rect: { x: 10, y: 20, width: 80, height: 30 },
        enabled: true,
        selected: false,
        hittable: true,
        depth: 0,
        parentIndex: null,
        pid: 1234,
        appName: 'TestApp',
        windowTitle: 'Main Window',
      },
      {
        index: 1,
        role: 'label',
        label: 'Hello',
        value: null,
        rect: null,
        enabled: true,
        selected: false,
        hittable: false,
        depth: 1,
        parentIndex: 0,
        pid: 1234,
        appName: 'TestApp',
        windowTitle: 'Main Window',
      },
    ]),
    stderr: '',
  });

  const result = await captureAccessibilityTree('desktop');

  assert.equal(result.nodes.length, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.surface, 'desktop');

  // Role normalization
  assert.equal(result.nodes[0]!.type, 'Button');
  assert.equal(result.nodes[0]!.role, 'push button');
  assert.equal(result.nodes[0]!.label, 'OK');
  assert.deepEqual(result.nodes[0]!.rect, { x: 10, y: 20, width: 80, height: 30 });

  assert.equal(result.nodes[1]!.type, 'StaticText');
  assert.equal(result.nodes[1]!.role, 'label');
  assert.equal(result.nodes[1]!.parentIndex, 0);
});

test('passes surface and limit args to Python script', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: makePythonResult([]),
    stderr: '',
  });

  await captureAccessibilityTree('frontmost-app', {
    maxNodes: 500,
    maxDepth: 8,
    maxApps: 10,
  });

  const callArgs = mockRunCmd.mock.calls[0]![1] as string[];
  assert.ok(callArgs.includes('--surface'));
  assert.ok(callArgs.includes('frontmost-app'));
  assert.ok(callArgs.includes('--max-nodes'));
  assert.ok(callArgs.includes('500'));
  assert.ok(callArgs.includes('--max-depth'));
  assert.ok(callArgs.includes('8'));
  assert.ok(callArgs.includes('--max-apps'));
  assert.ok(callArgs.includes('10'));
});

test('throws TOOL_MISSING when python3 is not found', async () => {
  mockWhichCmd.mockResolvedValue(false);

  await assert.rejects(
    () => captureAccessibilityTree('desktop'),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'TOOL_MISSING');
      assert.ok(err.message.includes('python3'));
      return true;
    },
  );
});

test('throws TOOL_MISSING when python3-gi is missing', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 1,
    stdout: '',
    stderr: "ModuleNotFoundError: No module named 'gi'",
  });

  await assert.rejects(
    () => captureAccessibilityTree('desktop'),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'TOOL_MISSING');
      assert.ok(err.message.includes('python3-gi'));
      return true;
    },
  );
});

test('throws COMMAND_FAILED on non-zero exit with unknown error', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 1,
    stdout: '',
    stderr: 'Segmentation fault',
  });

  await assert.rejects(
    () => captureAccessibilityTree('desktop'),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'COMMAND_FAILED');
      assert.ok(err.message.includes('Segmentation fault'));
      return true;
    },
  );
});

test('throws COMMAND_FAILED on invalid JSON output', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: 'not json at all',
    stderr: '',
  });

  await assert.rejects(
    () => captureAccessibilityTree('desktop'),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'COMMAND_FAILED');
      assert.ok(err.message.includes('invalid JSON'));
      return true;
    },
  );
});

test('throws COMMAND_FAILED when Python returns an error field', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({
      error: 'Could not get desktop accessible. Is the accessibility bus running?',
    }),
    stderr: '',
  });

  await assert.rejects(
    () => captureAccessibilityTree('desktop'),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'COMMAND_FAILED');
      assert.ok(err.message.includes('accessibility bus'));
      return true;
    },
  );
});

test('handles truncated result', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: makePythonResult(
      [{ index: 0, role: 'frame', label: 'Win', depth: 0, parentIndex: null }],
      true,
    ),
    stderr: '',
  });

  const result = await captureAccessibilityTree('desktop');
  assert.equal(result.truncated, true);
});

test('coerces null fields to undefined in node output', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: makePythonResult([
      {
        index: 0,
        role: 'panel',
        label: null,
        value: null,
        rect: null,
        enabled: null,
        selected: null,
        hittable: false,
        depth: 0,
        parentIndex: null,
        pid: null,
        appName: null,
        windowTitle: null,
      },
    ]),
    stderr: '',
  });

  const result = await captureAccessibilityTree('desktop');
  const node = result.nodes[0]!;
  assert.equal(node.label, undefined);
  assert.equal(node.value, undefined);
  assert.equal(node.rect, undefined);
  assert.equal(node.parentIndex, undefined);
  assert.equal(node.pid, undefined);
  assert.equal(node.appName, undefined);
  assert.equal(node.windowTitle, undefined);
});
