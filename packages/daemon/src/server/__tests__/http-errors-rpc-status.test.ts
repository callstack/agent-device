import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizeError } from '@agent-device/kernel/errors';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { prepareUploadedArtifact } from '../../resources/artifact-tracking.ts';
import { cleanupRetainedMaterializedPaths } from '../../sessions/materialized-path-registry.ts';
import { postRpcCommand, startRpcServer } from './http-server-rpc.fixtures.ts';

const TOKEN = 'expired-resource-token';

// An id a TTL registry no longer holds is a gone resource, not a daemon fault: `/rpc` answers 404
// whether the handler throws the expiry or returns it as its failed response.
test('a /rpc call naming an expired uploaded artifact answers 404 with the typed reason', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { port, server } = await startRpcServer(TOKEN, async () => {
    prepareUploadedArtifact(crypto.randomUUID());
    throw new Error('an unknown upload id must not resolve');
  });
  try {
    const answer = await postRpcCommand(port, TOKEN, 'req-expired-upload');
    assert.equal(answer.status, 404);
    assert.equal(answer.body.id, 'req-expired-upload');
    assert.equal(answer.body.error?.code, -32000);
    assert.equal(answer.body.error?.data?.details?.reason, 'RESOURCE_EXPIRED');
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a /rpc call answered with an expired materialized path id answers 404', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { port, server } = await startRpcServer(TOKEN, async () => {
    try {
      await cleanupRetainedMaterializedPaths(crypto.randomUUID());
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
    throw new Error('an unknown materialization id must not resolve');
  });
  try {
    const answer = await postRpcCommand(port, TOKEN, 'req-expired-materialization');
    assert.equal(answer.status, 404);
    assert.equal(answer.body.error?.data?.details?.reason, 'RESOURCE_EXPIRED');
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a /rpc COMMAND_FAILED without the expiry reason stays a 500', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { port, server } = await startRpcServer(TOKEN, async () => ({
    ok: false,
    error: { code: 'COMMAND_FAILED', message: 'not found or expired', details: {} },
  }));
  try {
    const answer = await postRpcCommand(port, TOKEN, 'req-plain-failure');
    assert.equal(answer.status, 500);
  } finally {
    await closeLoopbackServer(server);
  }
});
