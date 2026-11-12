import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'vitest';
import { createDaemonProxy } from '@agent-device/proxy';
import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { withProviderScenarioResource } from './harness.ts';
import { createFakeProviderWorld } from './provider-device-runtime.fixtures.ts';

test('Fetch proxy confines real resumable uploads to their authenticated tenant and canonical origin', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'Fetch proxy tenant uploads')) return;
  await withProviderScenarioResource(createFakeProviderWorld, async ({ daemon }) => {
    let forwarded = 0;
    const proxy = createDaemonProxy({
      upstreamBaseUrl: `http://127.0.0.1:${daemon.httpPort}`,
      upstreamToken: daemon.token,
      authenticate: (request) => {
        const auth = request.headers.get('authorization');
        if (auth === 'Bearer token-a') return { tenantId: 'tenant-a' };
        if (auth === 'Bearer token-b') return { tenantId: 'tenant-b' };
        return null;
      },
      upstreamFetch: async (request) => {
        forwarded += 1;
        return await fetch(request);
      },
    });
    const send = async (
      url: string,
      method: string,
      headers: Record<string, string>,
      body: string,
    ) => await proxy.handle(new Request(url, { method, headers, body }));
    const preflight = async (tenant: 'a' | 'b', content: string) => {
      const origin = `https://tenant-${tenant}.example`;
      const response = await send(
        `${origin}/agent-device/upload/preflight`,
        'POST',
        {
          authorization: `Bearer token-${tenant}`,
          'content-type': 'application/json',
          'x-forwarded-proto': 'http, https',
          'x-forwarded-host': 'evil.example, other.example',
        },
        JSON.stringify({
          uploadAttemptId: crypto.randomUUID(),
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          fileName: 'demo.apk',
          sizeBytes: content.length,
          artifactType: 'file',
          platform: 'android',
        }),
      );
      assert.equal(response.status, 200);
      const ticket = (await response.json()) as {
        uploadId: string;
        upload: { url: string; headers: Record<string, string> };
      };
      assert.equal(new URL(ticket.upload.url).origin, origin);
      assert.equal(
        new URL(ticket.upload.url).pathname,
        `/agent-device/upload/direct/${ticket.uploadId}`,
      );
      assert.equal(ticket.upload.headers.authorization, `Bearer token-${tenant}`);
      assert.ok(!JSON.stringify(ticket).includes(daemon.token));
      return { origin, ...ticket };
    };
    const before = forwarded;
    const refused = await send(
      'https://tenant-a.example/agent-device/upload/preflight',
      'POST',
      {
        authorization: 'Bearer invalid',
        'content-type': 'application/json',
      },
      '{}',
    );
    assert.equal(refused.status, 401);
    assert.equal(forwarded, before);

    const a = await preflight('a', 'ABCDE');
    const b = await preflight('b', 'VWXYZ');
    const forged = { authorization: 'Bearer token-b', 'x-agent-device-tenant': 'tenant-a' };
    const crossChunk = await send(
      a.upload.url,
      'PUT',
      { ...forged, 'content-range': 'bytes 0-1/5' },
      'AB',
    );
    assert.ok(crossChunk.status >= 400);
    const crossFinalize = await send(
      `${a.origin}/agent-device/upload/finalize`,
      'POST',
      { ...forged, 'content-type': 'application/json' },
      JSON.stringify({ uploadId: a.uploadId }),
    );
    assert.ok(crossFinalize.status >= 400);

    for (const [ticket, content] of [
      [a, 'ABCDE'],
      [b, 'VWXYZ'],
    ] as const) {
      const first = await send(
        ticket.upload.url,
        'PUT',
        { ...ticket.upload.headers, 'content-range': 'bytes 0-1/5' },
        content.slice(0, 2),
      );
      assert.equal(first.status, 308);
      assert.equal(first.headers.get('x-upload-offset'), '2');
      const second = await send(
        ticket.upload.url,
        'PUT',
        { ...ticket.upload.headers, 'content-range': 'bytes 2-4/5' },
        content.slice(2),
      );
      assert.equal(second.status, 200);
      const finalize = await send(
        `${ticket.origin}/agent-device/upload/finalize`,
        'POST',
        { ...ticket.upload.headers, 'content-type': 'application/json' },
        JSON.stringify({ uploadId: ticket.uploadId }),
      );
      assert.equal(finalize.status, 200);
      const result = (await finalize.json()) as { ok: boolean; uploadId: string };
      assert.equal(result.ok, true);
      assert.ok(result.uploadId);
    }
  });
});
