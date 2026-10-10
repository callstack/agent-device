import assert from 'node:assert/strict';
import { test } from 'vitest';
import { localRuntimeOwner, providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceClaimRuleForOwner } from '../device-claim-rule.ts';

// Production owns the exhaustiveness: `deviceClaimRuleForOwner` is a switch with no default arm, so
// a third owner kind fails to compile until it names a rule. This table would restate that claim
// as test data that no caller reads.
test('the device-claim rule selects ordinary for a local family and none for a provider runtime', () => {
  assert.equal(deviceClaimRuleForOwner(localRuntimeOwner('android')), 'ordinary');
  assert.equal(deviceClaimRuleForOwner(providerRuntimeOwner('limrun', 'instance-1')), 'none');
});
