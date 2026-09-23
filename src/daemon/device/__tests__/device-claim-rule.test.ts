import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  localRuntimeOwner,
  managedLocalRuntimeOwner,
  providerRuntimeOwner,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import { deviceClaimRuleForOwner, type DeviceClaimRule } from '../device-claim-rule.ts';

// Every owner kind names its rule here, so a fourth kind fails to compile until it does.
const RULE_BY_OWNER_KIND: Readonly<Record<RuntimeOwnerRef['kind'], DeviceClaimRule>> = {
  'local-family': 'ordinary',
  'managed-local': 'allocator-held',
  'provider-runtime': 'none',
};

test('the device-claim rule selects ordinary for a local family, allocator-held for a managed local owner, and none for a provider runtime', () => {
  assert.equal(deviceClaimRuleForOwner(localRuntimeOwner('android')), 'ordinary');
  assert.equal(deviceClaimRuleForOwner(managedLocalRuntimeOwner('sim-a')), 'allocator-held');
  assert.equal(deviceClaimRuleForOwner(providerRuntimeOwner('limrun', 'instance-1')), 'none');
});

test.each([
  localRuntimeOwner('apple'),
  managedLocalRuntimeOwner('sim-b'),
  providerRuntimeOwner('webdriver', 'tenant-a'),
])('the device-claim rule is exhaustive over owner kinds: $kind', (owner) => {
  assert.equal(deviceClaimRuleForOwner(owner), RULE_BY_OWNER_KIND[owner.kind]);
});
