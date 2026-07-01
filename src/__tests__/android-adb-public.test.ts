import assert from 'node:assert/strict';
import { test } from 'vitest';

test('public android-adb entrypoint exposes helpers but not resolver internals', async () => {
  const androidAdb = await import('../sdk/android-adb.ts');

  assert.equal(typeof androidAdb.createAndroidPortReverseManager, 'function');
  assert.equal(typeof androidAdb.captureAndroidLogcatWithAdb, 'function');
  assert.equal(typeof androidAdb.listAndroidAppsWithAdb, 'function');
  assert.equal(typeof androidAdb.getAndroidAppStateWithAdb, 'function');
  assert.equal(typeof androidAdb.readAndroidClipboardWithAdb, 'function');
  assert.equal(typeof androidAdb.dismissAndroidKeyboardWithAdb, 'function');
  assert.equal(typeof androidAdb.openAndroidAppWithAdb, 'function');

  assert.equal('resolveAndroidAdbProvider' in androidAdb, false);
  assert.equal('resolveAndroidAdbExecutor' in androidAdb, false);
  assert.equal('createDeviceAdbExecutor' in androidAdb, false);
  assert.equal('installAndroidAdbPackage' in androidAdb, false);
  assert.equal('pullAndroidAdbFile' in androidAdb, false);
  assert.equal('pushAndroidAdbFile' in androidAdb, false);
  assert.equal('withAndroidAdbProvider' in androidAdb, false);
  assert.equal('spawnAndroidAdbBySerial' in androidAdb, false);
});
