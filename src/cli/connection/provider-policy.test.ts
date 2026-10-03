import assert from 'node:assert/strict';
import { test } from 'vitest';
import { connectionProviderCapabilities } from './provider-policy.ts';

test('provider policy projects provider identity into semantic capabilities', () => {
  assert.deepEqual(connectionProviderCapabilities('limrun'), {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    supportsArtifacts: false,
    supportsDeferredAppSelection: true,
    supportsDirectPortReverse: true,
    usesCloudWebDriverLease: false,
  });
  const browserStack = connectionProviderCapabilities('browserstack');
  assert.equal(browserStack.supportsArtifacts, true);
  assert.equal(browserStack.usesCloudWebDriverLease, true);
  assert.equal(connectionProviderCapabilities('aws-device-farm').requiresAppAttachment, true);
  assert.equal(connectionProviderCapabilities('proxy').leaseKind, 'proxy');
});
