import {
  clickRuntimeUses,
  pressRuntimeUses,
} from '@agent-device/contracts/platform-runtime-operations';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

// #1900: the web coverage manifest's `press` row claims press shares click's admitted web
// operation ("press shares the admitted tapPoint fact that live click and press both require").
// That claim rests on `pressRuntimeUses` and the `press` descriptor literally being click's, not
// merely looking similar — pin both here so a future divergence fails this test, not silently.
test('press descriptor reuses the complete click plan uses with no legacy projection', () => {
  const click = commandDescriptors.find(({ name }) => name === 'click');
  const press = commandDescriptors.find(({ name }) => name === 'press');

  expect(click).not.toHaveProperty('capability');
  expect(click).not.toHaveProperty('dispatch');
  expect(press).not.toHaveProperty('capability');
  expect(press).not.toHaveProperty('dispatch');
  expect(click?.platformExecution).toEqual({ kind: 'device-runtime', uses: clickRuntimeUses });
  expect(press?.platformExecution).toEqual({ kind: 'device-runtime', uses: clickRuntimeUses });
  expect(pressRuntimeUses).toBe(clickRuntimeUses);
});
