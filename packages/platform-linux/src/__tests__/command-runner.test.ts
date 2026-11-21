import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createLinuxHostStub } from '../toolbox.fixtures.ts';

test('which looks up only bare names in the host PATH', async () => {
  const stub = createLinuxHostStub({ env: { PATH: '/usr/bin' }, tools: ['xdotool', 'evil'] });
  const { which } = stub.toolbox.commands;

  assert.equal(await which('xdotool'), true);
  assert.equal(await which('/usr/bin/xdotool'), true);
  // A relative path would be joined onto each PATH entry and resolve outside it.
  assert.equal(await which('../../tmp/evil'), false);
  assert.equal(await which('tmp/evil'), false);
  assert.equal(await which('evil\0'), false);
  assert.equal(await which('  '), false);
});
