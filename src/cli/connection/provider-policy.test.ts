import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  connectionProviderCapabilitiesForLease,
  connectionProviderCapabilitiesForVerification,
} from './provider-policy.ts';

test('provider carriers project provider identity into semantic capabilities', () => {
  assert.deepEqual(connectionProviderCapabilitiesForLease({ leaseProvider: 'limrun' }), {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    supportsArtifacts: false,
    supportsDeferredAppSelection: true,
    supportsDirectPortReverse: true,
    usesCloudWebDriverLease: false,
  });
  const browserStack = connectionProviderCapabilitiesForVerification({
    provider: 'browserstack',
  });
  assert.equal(browserStack.supportsArtifacts, true);
  assert.equal(browserStack.usesCloudWebDriverLease, true);
  assert.equal(
    connectionProviderCapabilitiesForLease({ leaseProvider: 'aws-device-farm' })
      .requiresAppAttachment,
    true,
  );
  assert.equal(
    connectionProviderCapabilitiesForLease({ leaseProvider: 'proxy' }).leaseKind,
    'proxy',
  );
});
