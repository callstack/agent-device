import assert from 'node:assert/strict';
import { test } from 'vitest';
import { hostAppDevice } from '@agent-device/kernel/device';
import { MACOS_DEVICE } from '@agent-device/test-kit';
import { makeMacOsSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';

test('findByDevice finds a session on an overlapping device: a host and its app devices', () => {
  const store = makeSessionStore();
  const textEdit = hostAppDevice(MACOS_DEVICE, 'com.apple.TextEdit');
  store.publish('text-edit', makeMacOsSession('text-edit', { device: textEdit }));

  assert.equal(store.findByDevice(MACOS_DEVICE.id)?.address, 'text-edit');
  assert.equal(store.findByDevice(textEdit.id)?.address, 'text-edit');
  assert.equal(
    store.findByDevice(hostAppDevice(MACOS_DEVICE, 'com.apple.calculator').id),
    undefined,
  );

  const desktop = makeSessionStore();
  desktop.publish('desktop', makeMacOsSession('desktop'));
  assert.equal(desktop.findByDevice(textEdit.id)?.address, 'desktop');
});
