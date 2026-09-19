import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeMissingKey,
  GATEWAY_KEY_VARIABLE,
  inputCostUsd,
  JEV_MODEL_ID,
  readGatewayKey,
} from './jev-client.ts';

test('the key is read from the environment only and an empty value counts as missing', () => {
  assert.deepEqual(readGatewayKey({ [GATEWAY_KEY_VARIABLE]: 'secret' }), {
    ok: true,
    apiKey: 'secret',
  });
  assert.deepEqual(readGatewayKey({}), {
    ok: false,
    error: { kind: 'missing-key', variable: 'AI_GATEWAY_API_KEY', model: 'typesafe-ai/jev' },
  });
  assert.equal(readGatewayKey({ [GATEWAY_KEY_VARIABLE]: '' }).ok, false);
});

test('the missing-key message names the variable and the model and promises no requests', () => {
  const message = describeMissingKey({
    kind: 'missing-key',
    variable: GATEWAY_KEY_VARIABLE,
    model: JEV_MODEL_ID,
  });
  assert.ok(message.includes('AI_GATEWAY_API_KEY'));
  assert.ok(message.includes('typesafe-ai/jev'));
  assert.ok(message.includes('No requests were made'));
});

test('cost is input tokens at the list price; output is free', () => {
  assert.equal(inputCostUsd(1_000_000), 0.042);
  assert.equal(inputCostUsd(0), 0);
});
