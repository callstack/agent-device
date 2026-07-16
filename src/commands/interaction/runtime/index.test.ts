import assert from 'node:assert/strict';
import { test } from 'vitest';
import { commands } from '../../index.ts';
import { selector } from './selector-read.ts';
import { createInteractionDevice, selectorSnapshot } from './__tests__/test-utils/index.ts';

test('runtime interaction commands are available from the command namespace', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async () => {},
  });

  const result = await commands.interactions.click(device, {
    session: 'default',
    target: selector('label=Continue'),
  });

  assert.equal(result.kind, 'selector');
});
