import { expect, onTestFinished, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';

const options = {
  upstreamBaseUrl: 'http://daemon.internal:4310',
  upstreamToken: 'daemon-secret',
  clientToken: 'client-secret',
};

const rpcBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'agent-device.command',
  params: { token: 'client-secret', command: 'version' },
});

// Keep module-registry mocks in this isolated file: existing HTTP listeners retain their module context.
test.each([false, true])(
  'non-transfer routes never load transfer mechanics (failure=%s)',
  async (failure) => {
    vi.resetModules();
    vi.doMock('./transfer-transport.ts', () => {
      throw new Error('transfer mechanics loaded');
    });
    onTestFinished(() => {
      vi.doUnmock('./transfer-transport.ts');
      vi.resetModules();
    });
    const { createDaemonProxy: create } = await import('./daemon-proxy.ts');
    const proxy = create({
      ...options,
      upstreamFetch: async () => {
        if (failure) throw new AppError('COMMAND_FAILED', 'original non-transfer failure');
        return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
      },
    });
    const transfer = new Request('http://gateway.test/artifacts/x');
    transfer.headers.set('authorization', 'Bearer client-secret');
    await expect(proxy.handle(transfer)).rejects.toThrow();
    for (const path of ['/rpc', '/health', '/sessions/s/requests/r/diagnostics']) {
      const response = await proxy.handle(
        new Request(`http://gateway.test${path}`, {
          method: path === '/rpc' ? 'POST' : 'GET',
          headers: { authorization: 'Bearer client-secret' },
          ...(path === '/rpc' ? { body: rpcBody } : {}),
        }),
      );
      expect(response.status, path).toBe(failure ? 500 : 200);
      const body = await response.json();
      if (failure) expect(JSON.stringify(body)).toContain('original non-transfer failure');
      expect(body).not.toHaveProperty('transferPhase');
      expect(body).not.toHaveProperty('timeoutMs');
    }
  },
);
