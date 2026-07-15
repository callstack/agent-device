import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isNonDiscriminatingAndroidId,
  readNodeLocalIdentity,
} from '../target-identity-node.ts';

// ---------------------------------------------------------------------------
// #1269: `android:id/*` is Android's OWN framework namespace (list-row
// titles, generic containers, ...), so unrelated sibling rows routinely share
// the exact same id — it must never win outright over a discriminating
// label the way an app-owned id does (decision 3's "Local identity").
// ---------------------------------------------------------------------------

test('isNonDiscriminatingAndroidId: true only for the android:id/* framework namespace', () => {
  assert.equal(isNonDiscriminatingAndroidId('android:id/title'), true);
  assert.equal(isNonDiscriminatingAndroidId('com.android.settings:id/network_and_internet_row'), false);
  assert.equal(isNonDiscriminatingAndroidId('save'), false);
  assert.equal(isNonDiscriminatingAndroidId(undefined), false);
});

test('readNodeLocalIdentity (#1269): a shared framework id is dropped when a label can discriminate instead', () => {
  const identity = readNodeLocalIdentity({
    type: 'TextView',
    identifier: 'android:id/title',
    label: 'Network & internet',
  });
  assert.deepEqual(identity, { role: 'textview', label: 'Network & internet' });
});

test('readNodeLocalIdentity (#1269): a unique (non-framework) resource id is still primary identity', () => {
  const identity = readNodeLocalIdentity({
    type: 'TextView',
    identifier: 'com.android.settings:id/network_and_internet_row',
    label: 'Network & internet',
  });
  assert.deepEqual(identity, {
    id: 'com.android.settings:id/network_and_internet_row',
    role: 'textview',
    label: 'Network & internet',
  });
});

test('readNodeLocalIdentity (#1269): a shared framework id with no label is kept — nothing else can discriminate', () => {
  const identity = readNodeLocalIdentity({ type: 'TextView', identifier: 'android:id/title' });
  assert.deepEqual(identity, { id: 'android:id/title', role: 'textview' });
});
