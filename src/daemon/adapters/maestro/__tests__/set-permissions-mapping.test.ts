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

  test('expands all to the platform servable set with specifics overriding', () => {
    assert.deepEqual(mapMaestroSetPermissions({ all: 'deny', notifications: 'unset' }, 'android'), [
      { state: 'deny', permission: 'camera' },
      { state: 'deny', permission: 'contacts' },
      { state: 'deny', permission: 'microphone' },
      { state: 'deny', permission: 'notifications' },
      { state: 'deny', permission: 'photos' },
      { state: 'reset', permission: 'notifications' },
    ]);
    const ios = mapMaestroSetPermissions({ all: 'allow' }, 'ios');
    assert.deepEqual(
      ios.map((mutation) => mutation.permission),
      [
        'calendar',
        'contacts',
        'location',
        'media-library',
        'microphone',
        'motion',
        'photos',
        'reminders',
        'siri',
      ],
    );
    assert.ok(ios.every((mutation) => mutation.state === 'grant'));
  });

  test('ios all skips the probe-unsupported camera and notifications', () => {
    // This host's `simctl privacy help` (the source the iOS backend probe
    // parses) lists neither service, so `all` excludes them rather than
    // stopping the sequential mutations partway through. Explicit entries
    // still reach the backend for its loud verdict.
    const permissions = mapMaestroSetPermissions({ all: 'deny' }, 'ios').map(
      (mutation) => mutation.permission,
    );
    assert.ok(!permissions.includes('camera'));
    assert.ok(!permissions.includes('notifications'));
    assert.deepEqual(mapMaestroSetPermissions({ camera: 'allow' }, 'ios'), [
      { state: 'grant', permission: 'camera' },
    ]);
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

  test('rejects unservable names, empty maps, and nonsense value combos', () => {
    assert.throws(
      () => mapMaestroSetPermissions({ bluetooth: 'allow' }, 'android'),
      /bluetooth.*not supported on android/i,
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
