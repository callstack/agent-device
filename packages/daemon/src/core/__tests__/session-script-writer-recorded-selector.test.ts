import type { SessionAction } from '@agent-device/contracts/session';
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSelectorChainForNode } from '@agent-device/selectors';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';

const hostCwd = createLiveTestHostEnvironment().cwd;

function action(overrides: Partial<SessionAction> = {}): SessionAction {
  return { ts: Date.now(), command: 'click', positionals: [], flags: {}, ...overrides };
}

function writeAndParse(
  writer: SessionScriptWriter,
  session: Parameters<SessionScriptWriter['write']>[0],
) {
  const result = writer.write(session);
  if (!result.written) throw new Error('expected the script to be written');
  const script = fs.readFileSync(result.path, 'utf8');
  return { script, parsed: parseReplayScriptDetailed(script) };
}

function row(index: number, label: string, identifier?: string): SnapshotNode {
  return { index, ref: `e${index}`, type: 'Button', label, ...(identifier ? { identifier } : {}) };
}

test.each([
  {
    name: 'a record-time-unique id writes only the id selector',
    nodes: [row(0, 'Wi-Fi', 'wifi'), row(1, 'Bluetooth', 'bluetooth')],
    expected: 'id="wifi"',
  },
  {
    name: 'a shared id is demoted and the role/label chain stays',
    nodes: [row(0, 'Wi-Fi', 'android:id/title'), row(1, 'Bluetooth', 'android:id/title')],
    expected: 'role="button" label="Wi-Fi" || label="Wi-Fi"',
  },
  {
    name: 'a node without an id keeps the role/label chain',
    nodes: [row(0, 'Wi-Fi'), row(1, 'Bluetooth')],
    expected: 'role="button" label="Wi-Fi" || label="Wi-Fi"',
  },
])('$name', ({ nodes, expected }) => {
  const root = mkdtempForTestSync('agent-device-script-writer-recorded-selector-');
  const writer = new SessionScriptWriter(path.join(root, 'sessions'), hostCwd);
  const selectorChain = buildSelectorChainForNode(nodes[0]!, 'android', { action: 'click', nodes });
  const session = makeAuthoringSession('default', {
    actions: [action({ command: 'press', positionals: ['@e0'], result: { selectorChain } })],
  });

  const { parsed } = writeAndParse(writer, session);
  expect(parsed.actions[0]?.positionals).toEqual([expected]);
});
