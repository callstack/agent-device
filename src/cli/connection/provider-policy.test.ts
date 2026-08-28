import assert from 'node:assert/strict';
import { test } from 'vitest';
import { connectionProviderSupportsDeferredAppSelection } from './provider-policy.ts';

test('only providers declaring deferred app selection use app catalog before allocation', () => {
  assert.equal(connectionProviderSupportsDeferredAppSelection('limrun'), true);
  assert.equal(connectionProviderSupportsDeferredAppSelection('browserstack'), false);
  assert.equal(connectionProviderSupportsDeferredAppSelection('aws-device-farm'), false);
  assert.equal(connectionProviderSupportsDeferredAppSelection('proxy'), false);
  assert.equal(connectionProviderSupportsDeferredAppSelection(undefined), false);
});
