import type { SessionAction } from '@agent-device/contracts/session';
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
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

test('a resolved longpress keeps its recorded duration when rewriting the selector', () => {
  const root = mkdtempForTestSync('agent-device-script-writer-longpress-duration-');
  const writer = new SessionScriptWriter(path.join(root, 'sessions'), hostCwd);
  const session = makeAuthoringSession('default', {
    actions: [
      action({
        command: 'longpress',
        positionals: ['@e4', '800'],
        result: { selectorChain: ['id="row"'] },
      }),
    ],
  });

  const { parsed } = writeAndParse(writer, session);
  expect(parsed.actions).toHaveLength(1);
  expect(parsed.actions[0]?.command).toBe('longpress');
  expect(parsed.actions[0]?.positionals).toEqual(['id="row"', '800']);
});

test('a resolved longpress without a duration positional writes the selector alone', () => {
  const root = mkdtempForTestSync('agent-device-script-writer-longpress-noduration-');
  const writer = new SessionScriptWriter(path.join(root, 'sessions'), hostCwd);
  const session = makeAuthoringSession('default', {
    actions: [
      action({
        command: 'longpress',
        positionals: ['@e4'],
        result: { selectorChain: ['id="row"'] },
      }),
    ],
  });

  const { parsed } = writeAndParse(writer, session);
  expect(parsed.actions[0]?.positionals).toEqual(['id="row"']);
});

test('a resolved longpress drops a blank or non-numeric trailing positional instead of writing it as a duration', () => {
  for (const junk of ['   ', 'abc']) {
    const root = mkdtempForTestSync('agent-device-script-writer-longpress-junk-');
    const writer = new SessionScriptWriter(path.join(root, 'sessions'), hostCwd);
    const session = makeAuthoringSession('default', {
      actions: [
        action({
          command: 'longpress',
          positionals: ['@e4', junk],
          result: { selectorChain: ['id="row"'] },
        }),
      ],
    });

    const { parsed } = writeAndParse(writer, session);
    expect(parsed.actions[0]?.positionals).toEqual(['id="row"']);
  }
});
