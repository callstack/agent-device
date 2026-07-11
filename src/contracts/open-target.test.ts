import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  IOS_SAFARI_BUNDLE_ID,
  isDeepLinkTarget,
  isWebUrl,
  resolveIosDeviceDeepLinkBundleId,
} from './open-target.ts';

test('isDeepLinkTarget accepts URL-style deep links', () => {
  assert.equal(isDeepLinkTarget('myapp://home'), true);
  assert.equal(isDeepLinkTarget('https://example.com'), true);
  assert.equal(isDeepLinkTarget('tel:123456789'), true);
  assert.equal(isDeepLinkTarget('mailto:test@example.com'), true);
});

test('isDeepLinkTarget rejects app identifiers and malformed URLs', () => {
  assert.equal(isDeepLinkTarget('com.example.app'), false);
  assert.equal(isDeepLinkTarget('settings'), false);
  assert.equal(isDeepLinkTarget('http:/x'), false);
});

test('isWebUrl accepts http and https URLs', () => {
  assert.equal(isWebUrl('https://example.com'), true);
  assert.equal(isWebUrl('http://example.com/path'), true);
  assert.equal(isWebUrl('https://example.com/path?q=1'), true);
});

test('isWebUrl rejects custom schemes and non-URLs', () => {
  assert.equal(isWebUrl('myapp://home'), false);
  assert.equal(isWebUrl('tel:123456789'), false);
  assert.equal(isWebUrl('com.example.app'), false);
  assert.equal(isWebUrl('settings'), false);
});

test('resolveIosDeviceDeepLinkBundleId prefers active app context', () => {
  assert.equal(
    resolveIosDeviceDeepLinkBundleId('com.example.app', 'myapp://home'),
    'com.example.app',
  );
});

test('resolveIosDeviceDeepLinkBundleId falls back to Safari for web URLs', () => {
  assert.equal(
    resolveIosDeviceDeepLinkBundleId(undefined, 'https://example.com/path'),
    IOS_SAFARI_BUNDLE_ID,
  );
});

test('resolveIosDeviceDeepLinkBundleId returns undefined for custom scheme without app context', () => {
  assert.equal(resolveIosDeviceDeepLinkBundleId(undefined, 'myapp://home'), undefined);
});
