import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runReactDevtoolsCommand } from '../cli/commands/react-devtools.ts';

const options = { stateDir: '/tmp/agent-device-state', session: 'default' };

test('react-devtools commands other than profile are invalid arguments with a profiling hint', async () => {
  await assert.rejects(
    runReactDevtoolsCommand(['get', 'tree'], options),
    (error: { code: string; message: string; details: { hint: string } }) => {
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.message, 'Unknown react-devtools command: get.');
      assert.match(error.details.hint, /react-devtools profile start/);
      return true;
    },
  );
});

test('react-devtools profile routes to the built-in profiler', async () => {
  await assert.rejects(
    runReactDevtoolsCommand(['profile', 'export', 'out.json'], options),
    /Unknown react-devtools profile command: export/,
  );
});
