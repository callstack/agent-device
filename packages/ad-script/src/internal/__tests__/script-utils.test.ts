import { expect, test } from 'vitest';
import type { SessionAction } from '@agent-device/contracts/session';
import { formatPortableActionLine } from '../script-formatting.ts';
import { parseReplayScriptDetailed } from '../script.ts';

test.each(['ios', 'android', 'harmonyos'] as const)(
  '%s runtime survives open and runtime set script roundtrips',
  (platform) => {
    const runtime = { platform, metroHost: 'localhost', metroPort: 8081 };
    const actions: SessionAction[] = [
      { ts: 0, command: 'runtime', positionals: ['set'], flags: runtime },
      { ts: 1, command: 'open', positionals: ['Demo'], flags: {}, runtime },
    ];
    const script = actions.map((action) => formatPortableActionLine(action)).join('\n');
    const parsed = parseReplayScriptDetailed(script);
    expect(parsed.actions[0]?.flags).toMatchObject(runtime);
    expect(parsed.actions[1]?.runtime).toMatchObject(runtime);
  },
);
