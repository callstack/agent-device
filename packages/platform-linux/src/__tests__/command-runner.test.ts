import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createLinuxHostStub } from '../toolbox.fixtures.ts';

test('which asks the host and passes its answer through', async () => {
  // The lookup rules belong to the host: it searches its own `PATH` for a bare name and asks an
  // absolute name of the filesystem (host-kit's `whichCmd` covers those branches). What this family
  // owns is asking the host rather than searching `PATH` itself, so a probe and the spawn it
  // authorizes read one environment.
  const stub = createLinuxHostStub({ env: { PATH: '/usr/bin' }, tools: ['xdotool'] });
  const { which } = stub.toolbox.commands;

  assert.equal(await which('xdotool'), true);
  assert.equal(await which('/usr/bin/xdotool'), true);
  assert.equal(await which('wmctrl'), false);
});
