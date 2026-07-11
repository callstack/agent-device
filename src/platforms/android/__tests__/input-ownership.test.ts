import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  classifyAndroidInputOwnership,
  parseAndroidInputMethodPackage,
  readAndroidActiveInputMethodPackage,
} from '../../../contracts/android-input-ownership.ts';

test('classifies active input method package as IME-owned', () => {
  assert.deepEqual(
    classifyAndroidInputOwnership({
      packageName: 'com.vendor.keyboard',
      activeInputMethodPackage: 'com.vendor.keyboard',
    }),
    {
      inputMethodOwned: true,
      source: 'active-input-method',
    },
  );
  assert.deepEqual(
    classifyAndroidInputOwnership({
      packageName: 'com.android.systemui',
      resourceId: 'com.vendor.keyboard:id/handwriting',
      activeInputMethodPackage: 'com.vendor.keyboard',
    }),
    {
      inputMethodOwned: true,
      source: 'active-input-method-resource',
    },
  );
});

test('keeps package-name fallbacks narrow to known IMEs', () => {
  assert.deepEqual(
    classifyAndroidInputOwnership({
      packageName: 'com.google.android.inputmethod.latin',
    }),
    {
      inputMethodOwned: true,
      source: 'known-ime-package',
    },
  );
  assert.deepEqual(
    classifyAndroidInputOwnership({
      packageName: 'com.example.inputmethod.demo',
    }),
    {
      inputMethodOwned: false,
      source: 'app',
    },
  );
});

test('classifies known IME resource ids as fallback signal', () => {
  assert.deepEqual(
    classifyAndroidInputOwnership({
      packageName: 'com.android.systemui',
      resourceId: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
    }),
    {
      inputMethodOwned: true,
      source: 'known-ime-resource',
    },
  );
});

test('parses active input method package from dumpsys values', () => {
  assert.equal(
    parseAndroidInputMethodPackage('com.google.android.inputmethod.latin/.LatinIME'),
    'com.google.android.inputmethod.latin',
  );
  assert.equal(
    readAndroidActiveInputMethodPackage(
      'mInputShown=true mCurMethodId=com.vendor.keyboard/.KeyboardService inputType=0x1',
    ),
    'com.vendor.keyboard',
  );
});
