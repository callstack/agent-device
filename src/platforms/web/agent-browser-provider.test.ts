import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { createAgentBrowserWebProvider } from './agent-browser-provider.ts';
import type { WebSnapshotResult } from './provider.ts';
import { withCommandExecutorOverride, type ExecResult } from '../../utils/exec.ts';
import { AppError } from '../../utils/errors.ts';
import {
  buildSelectorChainForNode,
  parseSelectorChain,
  resolveSelectorChain,
} from '../../daemon/selectors.ts';
import { attachRefs } from '../../utils/snapshot.ts';
import { installFakeManagedAgentBrowser } from './__tests__/test-utils.ts';

type AgentBrowserCall = {
  cmd: string;
  args: string[];
};

test('agent-browser provider maps supported operations to session-scoped JSON commands', async () => {
  await withManagedAgentBrowserProvider({ session: 'web-session' }, async (provider) => {
    const calls: AgentBrowserCall[] = [];

    await withCommandExecutorOverride(recordingExecutor(calls), async () => {
      await provider.open('https://example.test');
      await provider.screenshot('/tmp/page.png', { fullscreen: true });
      await provider.click(10.4, 20.6);
      await provider.fill(11, 22, 'Ada');
      await provider.typeText('hello');
      await provider.scroll('down', { pixels: 400 });
      await provider.close();
    });

    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['open', 'https://example.test', '--json', '--session', 'web-session'],
        ['screenshot', '--full', '/tmp/page.png', '--json', '--session', 'web-session'],
        ['mouse', 'move', '10', '21', '--json', '--session', 'web-session'],
        ['mouse', 'down', '--json', '--session', 'web-session'],
        ['mouse', 'up', '--json', '--session', 'web-session'],
        ['mouse', 'move', '11', '22', '--json', '--session', 'web-session'],
        ['mouse', 'down', '--json', '--session', 'web-session'],
        ['mouse', 'up', '--json', '--session', 'web-session'],
        ['press', expectedSelectAllShortcut(), '--json', '--session', 'web-session'],
        ['keyboard', 'type', 'Ada', '--json', '--session', 'web-session'],
        ['keyboard', 'type', 'hello', '--json', '--session', 'web-session'],
        ['scroll', 'down', '400', '--json', '--session', 'web-session'],
        ['close', '--json', '--session', 'web-session'],
      ],
    );
  });
});

test('agent-browser provider normalizes snapshot refs, labels, values, parents, and rects', async () => {
  await withManagedAgentBrowserProvider({ session: 'web-session' }, async (provider) => {
    const calls: AgentBrowserCall[] = [];
    const snapshot = await withCommandExecutorOverride(
      snapshotExecutor(calls),
      async () => await provider.snapshot({ interactiveOnly: true, depth: 4, scope: '#main' }),
    );

    assert.deepEqual(calls[0]?.args, [
      'snapshot',
      '--interactive',
      '--compact',
      '--depth',
      '4',
      '--selector',
      '#main',
      '--json',
      '--session',
      'web-session',
    ]);
    assertNormalizedSnapshot(snapshot);
    assertRoleSelectorResolves(snapshot);
  });
});

test('agent-browser provider surfaces stale ref failures during snapshot geometry lookup', async () => {
  await withManagedAgentBrowserProvider({ session: 'web-session' }, async (provider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async (_cmd, args) => {
            if (args[0] === 'snapshot') {
              return jsonResult({
                success: true,
                data: {
                  refs: { e1: { role: 'button', name: 'Save' } },
                  snapshot: 'button "Save" [ref=e1]',
                },
              });
            }
            return jsonResult({ success: false, error: 'Stale ref @e1' });
          },
          async () => await provider.snapshot(),
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'COMMAND_FAILED' &&
        error.message === 'Stale ref @e1',
    );
  });
});

test('agent-browser provider adds doctor guidance for missing binary and invalid JSON', async () => {
  const missingStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-web-provider-missing-'),
  );
  try {
    const provider = createAgentBrowserWebProvider({ stateDir: missingStateDir });
    await assert.rejects(
      async () => await provider.open('https://example.test'),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'TOOL_MISSING' &&
        error.details?.hint === 'Run `agent-device web setup` to install the managed web backend.',
    );
  } finally {
    fs.rmSync(missingStateDir, { recursive: true, force: true });
  }

  await withManagedAgentBrowserProvider({}, async (installedProvider) => {
    await assert.rejects(
      () =>
        withCommandExecutorOverride(
          async () => ({ stdout: 'not-json', stderr: '', exitCode: 0 }),
          async () => await installedProvider.open('https://example.test'),
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'COMMAND_FAILED' &&
        error.message === 'agent-browser returned invalid JSON' &&
        typeof error.details?.hint === 'string',
    );
  });
});

async function withManagedAgentBrowserProvider(
  options: { session?: string },
  testFn: (provider: ReturnType<typeof createAgentBrowserWebProvider>) => void | Promise<void>,
): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-provider-'));
  try {
    installFakeManagedAgentBrowser(stateDir);
    const provider = createAgentBrowserWebProvider({ ...options, stateDir });
    await testFn(provider);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function recordingExecutor(calls: AgentBrowserCall[]) {
  return async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push({ cmd, args });
    return jsonResult({ success: true, data: {} });
  };
}

function snapshotExecutor(calls: AgentBrowserCall[]) {
  return async (cmd: string, args: string[], options: { allowFailure?: boolean }) => {
    calls.push({ cmd, args });
    if (args[0] === 'snapshot') return snapshotPayload();
    if (args.slice(0, 3).join(' ') === 'get box @e3') {
      assert.equal(options.allowFailure, true);
      return jsonResult({ success: false, error: 'No box for element' }, 1);
    }
    if (args[0] === 'get' && args[1] === 'box') return boxPayload(args[2]);
    return jsonResult({ success: true, data: {} });
  };
}

function assertNormalizedSnapshot(snapshot: WebSnapshotResult): void {
  assert.deepEqual(snapshot.nodes, [
    expectedNode(0, 'heading', 'Welcome', undefined, 0, { x: 1, y: 2, width: 100, height: 20 }),
    expectedNode(1, 'textbox', 'Name', 'Ada', 1, { x: 11, y: 12, width: 100, height: 20 }, 0),
    expectedNode(2, 'button', 'Save', undefined, 1, undefined, 0),
    expectedNode(3, 'link', 'Docs', undefined, 1, { x: 31, y: 32, width: 100, height: 20 }, 0),
  ]);
}

function assertRoleSelectorResolves(snapshot: WebSnapshotResult): void {
  const nodesWithRefs = attachRefs(snapshot.nodes);
  const selectorChain = buildSelectorChainForNode(nodesWithRefs[2]!, 'web');
  assert.deepEqual(selectorChain, ['role="button" label="Save"', 'label="Save"']);
  const resolved = resolveSelectorChain(nodesWithRefs, parseSelectorChain(selectorChain[0]!), {
    platform: 'web',
  });
  assert.equal(resolved?.node.label, 'Save');
}

function expectedNode(
  index: number,
  type: string,
  label: string,
  value: string | undefined,
  depth: number,
  rect: { x: number; y: number; width: number; height: number } | undefined,
  parentIndex?: number,
) {
  return {
    index,
    type,
    role: type,
    label,
    value,
    depth,
    enabled: undefined,
    focused: undefined,
    ...(parentIndex === undefined ? {} : { parentIndex }),
    ...(rect ? { rect } : {}),
  };
}

function snapshotPayload(): ExecResult {
  return jsonResult({
    success: true,
    data: {
      refs: {
        e1: { role: 'heading', name: 'Welcome' },
        e2: { role: 'textbox', name: 'Name' },
        e3: { role: 'button', name: 'Save' },
        e4: { role: 'link', name: 'Docs' },
      },
      snapshot: [
        '- heading "Welcome" [ref=e1]',
        '  - textbox "Name" [ref=e2]: Ada',
        '  - button "Save" [ref=e3]',
        '  - link "Docs" [ref=e4]',
      ].join('\n'),
      truncated: false,
    },
  });
}

function boxPayload(ref: string | undefined): ExecResult {
  const offset = ref === '@e1' ? 0 : ref === '@e2' ? 10 : 30;
  return jsonResult({
    success: true,
    data: { x: offset + 1, y: offset + 2, width: 100, height: 20 },
  });
}

function jsonResult(value: unknown, exitCode = 0): ExecResult {
  return { stdout: JSON.stringify(value), stderr: '', exitCode };
}

function expectedSelectAllShortcut(): string {
  return process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
}
