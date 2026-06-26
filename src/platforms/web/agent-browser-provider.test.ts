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
      const startRecording = await provider.startRecording?.('/tmp/clip.webm');
      await provider.screenshot('/tmp/page.png', { fullscreen: true });
      await provider.setViewport(1280, 900);
      await provider.click(10.4, 20.6);
      await provider.clickRef?.('@e3');
      await provider.fill(11, 22, 'Ada');
      await provider.fillRef?.('@e2', 'Grace');
      await provider.typeText('hello');
      await provider.scroll('down', { pixels: 400 });
      const scrollResult = await provider.scroll('up', { pixels: 100, durationMs: 120 });
      assert.deepEqual(scrollResult, { durationMs: 120 });
      const stopRecording = await provider.stopRecording?.();
      await provider.close();

      assert.equal(startRecording, undefined);
      assert.equal(stopRecording, undefined);
    });

    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['open', 'https://example.test', '--json', '--session', 'web-session'],
        ['record', 'start', '/tmp/clip.webm', '--json', '--session', 'web-session'],
        ['screenshot', '--full', '/tmp/page.png', '--json', '--session', 'web-session'],
        ['set', 'viewport', '1280', '900', '--json', '--session', 'web-session'],
        ['mouse', 'move', '10', '21', '--json', '--session', 'web-session'],
        ['mouse', 'down', '--json', '--session', 'web-session'],
        ['mouse', 'up', '--json', '--session', 'web-session'],
        ['click', '@e3', '--json', '--session', 'web-session'],
        ['mouse', 'move', '11', '22', '--json', '--session', 'web-session'],
        ['mouse', 'down', '--json', '--session', 'web-session'],
        ['mouse', 'up', '--json', '--session', 'web-session'],
        ['press', expectedSelectAllShortcut(), '--json', '--session', 'web-session'],
        ['keyboard', 'type', 'Ada', '--json', '--session', 'web-session'],
        ['fill', '@e2', 'Grace', '--json', '--session', 'web-session'],
        ['keyboard', 'type', 'hello', '--json', '--session', 'web-session'],
        ['scroll', 'down', '400', '--json', '--session', 'web-session'],
        ['scroll', 'up', '34', '--json', '--session', 'web-session'],
        ['scroll', 'up', '33', '--json', '--session', 'web-session'],
        ['scroll', 'up', '33', '--json', '--session', 'web-session'],
        ['record', 'stop', '--json', '--session', 'web-session'],
        ['close', '--json', '--session', 'web-session'],
      ],
    );
  });
});

test('agent-browser provider normalizes snapshot refs, labels, values, and parents', async () => {
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
    assert.equal(calls.length, 1);
    assertNormalizedSnapshot(snapshot);
    assertRoleSelectorResolves(snapshot);
  });
});

test('agent-browser provider fetches snapshot rects only when requested', async () => {
  await withManagedAgentBrowserProvider({ session: 'web-session' }, async (provider) => {
    const calls: AgentBrowserCall[] = [];
    const snapshot = await withCommandExecutorOverride(
      snapshotExecutor(calls),
      async () => await provider.snapshot({ includeRects: true }),
    );

    assert.deepEqual(
      calls.map((call) => call.args.slice(0, 3)),
      [
        ['snapshot', '--compact', '--json'],
        ['get', 'box', '@e1'],
        ['get', 'box', '@e2'],
        ['get', 'box', '@e3'],
        ['get', 'box', '@e4'],
      ],
    );
    assertNormalizedSnapshot(snapshot);
    assertSnapshotRects(snapshot);
    assertRoleSelectorResolves(snapshot);
  });
});

test('agent-browser provider dumps session network requests', async () => {
  await withManagedAgentBrowserProvider({ session: 'web-session' }, async (provider) => {
    const calls: AgentBrowserCall[] = [];
    const executor = async (cmd: string, args: string[]): Promise<ExecResult> => {
      calls.push({ cmd, args });
      return jsonResult({
        success: true,
        data: {
          requests: [
            {
              headers: { Authorization: 'Bearer test', Accept: 'application/json' },
              method: 'GET',
              mimeType: 'application/json',
              requestId: 'req-1',
              resourceType: 'fetch',
              responseHeaders: { 'content-type': 'application/json' },
              status: 200,
              timestamp: 1_782_119_299_500,
              url: 'https://example.test/api',
            },
          ],
        },
      });
    };
    const network = await withCommandExecutorOverride(
      executor,
      async () => await provider.dumpNetwork?.({ include: 'headers', limit: 5 }),
    );
    const summary = await withCommandExecutorOverride(
      executor,
      async () => await provider.dumpNetwork?.({ include: 'summary', limit: 5 }),
    );

    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['network', 'requests', '--json', '--session', 'web-session'],
        ['network', 'requests', '--json', '--session', 'web-session'],
      ],
    );
    assert.deepEqual(network, {
      entries: [
        {
          timestamp: '2026-06-22T09:08:19.500Z',
          method: 'GET',
          url: 'https://example.test/api',
          status: 200,
          requestHeaders: { Authorization: 'Bearer test', Accept: 'application/json' },
          responseHeaders: { 'content-type': 'application/json' },
          metadata: {
            requestId: 'req-1',
            resourceType: 'fetch',
            mimeType: 'application/json',
          },
        },
      ],
      backend: 'agent-browser',
      redacted: false,
    });
    const summaryEntry = summary?.entries[0];
    assert.equal(summaryEntry?.requestHeaders, undefined);
    assert.equal(summaryEntry?.responseHeaders, undefined);
  });
});

test('agent-browser provider surfaces stale ref failures during requested snapshot geometry lookup', async () => {
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
          async () => await provider.snapshot({ includeRects: true }),
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

test('agent-browser provider preserves Node version guidance for missing managed backend', async () => {
  await withNodeRuntimeVersion('22.19.0', async () => {
    const missingStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-device-web-provider-node-'),
    );
    try {
      const provider = createAgentBrowserWebProvider({ stateDir: missingStateDir });
      await assert.rejects(
        async () => await provider.open('https://example.test'),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'TOOL_MISSING' &&
          error.details?.hint === 'Web automation requires Node 24+; current Node is v22.19.0.' &&
          error.details?.version === '0.27.1' &&
          typeof error.details?.installDir === 'string',
      );
    } finally {
      fs.rmSync(missingStateDir, { recursive: true, force: true });
    }
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

async function withNodeRuntimeVersion(
  version: string,
  testFn: () => void | Promise<void>,
): Promise<void> {
  const originalNodeVersion = process.versions.node;
  const originalProcessVersion = process.version;
  Object.defineProperty(process.versions, 'node', { value: version, configurable: true });
  Object.defineProperty(process, 'version', { value: `v${version}`, configurable: true });
  try {
    await testFn();
  } finally {
    Object.defineProperty(process.versions, 'node', {
      value: originalNodeVersion,
      configurable: true,
    });
    Object.defineProperty(process, 'version', {
      value: originalProcessVersion,
      configurable: true,
    });
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
  const nodesWithoutRects = snapshot.nodes.map(({ rect: _rect, ...node }) => node);
  assert.deepEqual(nodesWithoutRects, [
    expectedNode(0, 'heading', 'Welcome', undefined, 0, undefined),
    expectedNode(1, 'textbox', 'Name', 'Ada', 1, undefined, 0),
    expectedNode(2, 'button', 'Save', undefined, 1, undefined, 0),
    expectedNode(3, 'link', 'Docs', undefined, 1, undefined, 0),
  ]);
}

function assertSnapshotRects(snapshot: WebSnapshotResult): void {
  assert.deepEqual(
    snapshot.nodes.map((node) => node.rect),
    [
      { x: 1, y: 2, width: 100, height: 20 },
      { x: 11, y: 12, width: 100, height: 20 },
      undefined,
      { x: 31, y: 32, width: 100, height: 20 },
    ],
  );
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
