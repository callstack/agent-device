import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runReactDevtoolsCommand } from './react-devtools.ts';

afterEach(() => vi.restoreAllMocks());

for (const json of [false, true]) {
  test(`saved profile output preserves ${json ? 'JSON envelope' : 'text newline'} through the package`, async () => {
    const stateDir = mkdtempForTestSync('react-devtools-cli-');
    const dir = path.join(stateDir, 'react-profiles');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'qa.json'),
      JSON.stringify({
        version: 2,
        savedAt: '2026-10-16T00:00:00.000Z',
        profile: {
          startedAt: 0,
          stoppedAt: 1000,
          naming: 'operations',
          elements: {},
          keys: [],
          commits: [],
        },
        propKinds: {},
        notes: [],
      }),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const code = await runReactDevtoolsCommand(['profile', 'commit'], {
      stateDir,
      session: 'qa',
      flags: { json },
    });
    assert.equal(code, 0);
    assert.equal(
      output.join(''),
      json
        ? JSON.stringify({ success: true, data: { commits: [] } }, null, 2) + '\n'
        : 'No commits recorded.\n',
    );
  });
}

test('unknown commands preserve the package error at the CLI adapter', async () => {
  await assert.rejects(
    runReactDevtoolsCommand(['unknown'], { stateDir: '/unused', session: 'qa' }),
    { code: 'INVALID_ARGS', message: 'Unknown react-devtools command: unknown.' },
  );
});
