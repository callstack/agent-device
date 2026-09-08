import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { mapMaestroSetPermissions } from '../set-permissions-mapping.ts';

describe('mapMaestroSetPermissions', () => {
  test('maps single permissions to grant/deny/reset', () => {
    assert.deepEqual(
      mapMaestroSetPermissions({ camera: 'allow', notifications: 'deny' }, 'android'),
      [
        { state: 'grant', permission: 'camera' },
        { state: 'deny', permission: 'notifications' },
      ],
    );
    assert.deepEqual(mapMaestroSetPermissions({ notifications: 'unset' }, 'android'), [
      { state: 'reset', permission: 'notifications' },
    ]);
  });

  test('all travels as one backend call with specifics overriding after it', () => {
    assert.deepEqual(mapMaestroSetPermissions({ all: 'deny', notifications: 'unset' }, 'android'), [
      { state: 'deny', permission: 'all' },
      { state: 'reset', permission: 'notifications' },
    ]);
    assert.deepEqual(mapMaestroSetPermissions({ all: 'allow' }, 'ios'), [
      { state: 'grant', permission: 'all' },
    ]);
    assert.throws(
      () => mapMaestroSetPermissions({ all: 'never' }, 'ios'),
      /'allow', 'deny' or 'unset'/i,
    );
    assert.throws(
      () => mapMaestroSetPermissions({ all: 'limited' }, 'ios'),
      /'allow', 'deny' or 'unset'/i,
    );
  });

  test('maps iOS granular values and the medialibrary alias', () => {
    assert.deepEqual(mapMaestroSetPermissions({ location: 'always' }, 'ios'), [
      { state: 'grant', permission: 'location-always' },
    ]);
    assert.deepEqual(mapMaestroSetPermissions({ location: 'inuse' }, 'ios'), [
      { state: 'grant', permission: 'location' },
    ]);
    assert.deepEqual(mapMaestroSetPermissions({ location: 'never' }, 'ios'), [
      { state: 'deny', permission: 'location' },
    ]);
    // never denies access while unset restores the prompt state.
    assert.deepEqual(mapMaestroSetPermissions({ location: 'unset' }, 'ios'), [
      { state: 'reset', permission: 'location' },
    ]);
    assert.deepEqual(mapMaestroSetPermissions({ photos: 'limited' }, 'ios'), [
      { state: 'grant', permission: 'photos', mode: 'limited' },
    ]);
    assert.deepEqual(mapMaestroSetPermissions({ medialibrary: 'allow' }, 'ios'), [
      { state: 'grant', permission: 'media-library' },
    ]);
  });

  test('maps the extended Android names to backend targets', () => {
    assert.deepEqual(mapMaestroSetPermissions({ bluetooth: 'allow' }, 'android'), [
      { state: 'grant', permission: 'bluetooth' },
    ]);
    assert.deepEqual(mapMaestroSetPermissions({ location: 'deny' }, 'android'), [
      { state: 'deny', permission: 'location' },
    ]);
    assert.deepEqual(mapMaestroSetPermissions({ sms: 'unset' }, 'android'), [
      { state: 'reset', permission: 'sms' },
    ]);
  });

  test('rejects unservable names, empty maps, and nonsense value combos', () => {
    assert.throws(
      () => mapMaestroSetPermissions({ health: 'allow' }, 'android'),
      /health.*not supported on android/i,
    );
    assert.throws(
      () => mapMaestroSetPermissions({ speech: 'allow' }, 'ios'),
      /speech.*not supported on ios/i,
    );
    assert.throws(
      () =>
        mapMaestroSetPermissions(
          { 'android.permission.MANAGE_EXTERNAL_STORAGE': 'deny' },
          'android',
        ),
      /not supported on android/i,
    );
    assert.throws(() => mapMaestroSetPermissions({}, 'ios'), /at least one permission/i);
    assert.throws(
      () => mapMaestroSetPermissions({ camera: 'always' }, 'ios'),
      /camera.*does not accept.*always/i,
    );
  });
});
