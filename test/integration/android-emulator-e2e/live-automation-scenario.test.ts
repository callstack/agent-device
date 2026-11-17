import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { parseWaitPositionals } from '@agent-device/command-registry/wait-positionals';
import { createCommandSurfaceAgentDevice } from '@agent-device/command-runtime';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { assertAutomationSystem } from './live-automation-scenario.ts';
import type { LiveContext } from './live-harness.ts';

const harness = vi.hoisted(() => ({
  runStep: vi.fn(),
  verifyCommand: vi.fn(),
  verifyBehavior: vi.fn(),
}));
vi.mock('./live-harness.ts', () => harness);

test('catalog readiness waits until the automation screen has changed', async () => {
  const previous = makeSnapshotState([
    { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Automation lab' },
    {
      index: 1,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Continue to catalog',
      identifier: 'automation-continue-catalog',
      rect: { x: 90, y: 1642, width: 900, height: 124 },
    },
  ]);
  const catalog = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'android.view.ViewGroup',
      identifier: 'catalog-title',
      rect: { x: 47, y: 419, width: 986, height: 286 },
    },
    { index: 1, depth: 1, parentIndex: 0, type: 'android.widget.TextView', label: 'Catalog' },
    { index: 2, depth: 0, type: 'android.widget.Button', label: 'Settings', ref: 'e3' },
  ]);
  let captures = 0;
  let elapsed = 0;
  const device = createCommandSurfaceAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => ({ snapshot: captures++ === 0 ? previous : catalog }),
    },
    artifacts: createLocalArtifactAdapter({ cwd: process.cwd() }),
    policy: localCommandPolicy(),
    clock: {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    },
  });
  device.sessions.set({ name: 'default' });
  const done = new Error('reached Settings navigation');
  harness.runStep.mockImplementation(async (_context, _step, args: string[]) => {
    const result = (data: unknown) => ({
      status: 0,
      stdout: '',
      stderr: '',
      json: { success: true, data },
    });
    if (args[0] === 'get')
      return result({
        text: args[2]?.includes('payload') ? '{"source":"android-deep-link"}' : 'cold.start',
      });
    if (args[0] === 'wait') {
      const parsed = parseWaitPositionals(args.slice(1));
      assert.ok(parsed && (parsed.kind === 'text' || parsed.kind === 'selector'));
      const target =
        parsed.kind === 'text'
          ? { kind: 'text' as const, text: parsed.text, timeoutMs: parsed.timeoutMs ?? 10000 }
          : {
              kind: 'selector' as const,
              selector: parsed.selectorExpression,
              timeoutMs: parsed.timeoutMs ?? 10000,
            };
      const waited = await device.selectors.wait({ session: 'default', target });
      assert.equal(captures, 2, 'readiness must not complete on Automation lab');
      return result(waited);
    }
    if (args[0] === 'snapshot')
      return result({
        nodes: catalog.nodes,
        androidSnapshot: {
          backend: 'android-helper',
          helperTransport: 'persistent-session',
          helperSessionReused: true,
        },
      });
    if (args[0] === 'click' && args[1]?.startsWith('@')) throw done;
    return result({});
  });
  await assert.rejects(assertAutomationSystem({} as LiveContext), (error) => error === done);
});
