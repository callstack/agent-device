import { expect, test } from 'vitest';
import { makeIosSession } from '../../../__tests__/test-utils/index.ts';
import { recordActionEntry } from '../../session-action-recorder.ts';
import type { DaemonRequest, SessionAction } from '../../types.ts';
import { invokeReplayAction } from '../session-replay-action-runtime.ts';

const REPLAY_REQUEST: DaemonRequest = {
  token: 'token',
  session: 'default',
  command: 'replay',
  positionals: ['login.ad'],
  flags: {},
};

test.each(['', '   '])(
  'replay keeps source placeholder provenance when PASSWORD resolves to %j',
  async (value) => {
    const session = makeIosSession('default');
    const sourceAction: SessionAction = {
      ts: 0,
      command: 'fill',
      positionals: ['id="password"', '${PASSWORD}'],
      flags: {},
    };
    const response = await invokeReplayAction({
      req: REPLAY_REQUEST,
      sessionName: 'default',
      action: sourceAction,
      scope: { values: { PASSWORD: value } },
      filePath: 'login.ad',
      line: 1,
      step: 1,
      invoke: async (request) => {
        recordActionEntry(session, {
          command: request.command,
          positionals: request.positionals ?? [],
          flags: request.flags ?? {},
          result: { text: request.positionals?.at(-1) },
        });
        return { ok: true, data: {} };
      },
    });

    expect(response.ok).toBe(true);
    expect(session.actions[0]?.positionals).toEqual(['id="password"', '${PASSWORD}']);
    expect(session.actions[0]?.result?.text).toBe('${PASSWORD}');
  },
);
