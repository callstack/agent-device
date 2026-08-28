import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  connectionProviderRequiresAppAttachment,
  connectionProviderSupportsArtifacts,
  connectionProviderSupportsDeferredAppSelection,
  connectionProviderSupportsDirectPortReverse,
  connectionProviderUsesCloudWebDriverLease,
} from './provider-policy.ts';

test('only providers declaring deferred app selection use app catalog before allocation', () => {
  assert.equal(connectionProviderSupportsDeferredAppSelection('limrun'), true);
  assert.equal(connectionProviderSupportsDeferredAppSelection('browserstack'), false);
  assert.equal(connectionProviderSupportsDeferredAppSelection('aws-device-farm'), false);
  assert.equal(connectionProviderSupportsDeferredAppSelection('proxy'), false);
  assert.equal(connectionProviderSupportsDeferredAppSelection(undefined), false);
});

test('provider capabilities stay declared outside command implementations', () => {
  assert.equal(connectionProviderRequiresAppAttachment('aws-device-farm'), true);
  assert.equal(connectionProviderRequiresAppAttachment('browserstack'), false);
  assert.equal(connectionProviderSupportsArtifacts('aws-device-farm'), true);
  assert.equal(connectionProviderSupportsArtifacts('browserstack'), true);
  assert.equal(connectionProviderSupportsArtifacts('limrun'), false);
  assert.equal(connectionProviderSupportsDirectPortReverse('limrun'), true);
  assert.equal(connectionProviderSupportsDirectPortReverse('aws-device-farm'), false);
  assert.equal(connectionProviderUsesCloudWebDriverLease('browserstack'), true);
  assert.equal(connectionProviderUsesCloudWebDriverLease('aws-device-farm'), true);
  assert.equal(connectionProviderUsesCloudWebDriverLease('limrun'), false);
});
