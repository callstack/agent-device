import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createVphoneTransport, type VphoneProcessResult } from './transport.ts';

function result(stdout: string, extra: Partial<VphoneProcessResult> = {}): VphoneProcessResult {
  return { stdout, stderr: '', ...extra };
}

test('RPC returns the result and applies bounded exec options', async () => {
  let captured:
    | { file: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number }
    | undefined;
  const transport = createVphoneTransport({
    cli: '/fixture/vphone',
    timeoutMs: 1234,
    maxOutputBytes: 4567,
    execFile: async (file, args, options) => {
      captured = { file, args, ...options };
      return result('{"ok":true,"result":{"count":2}}');
    },
  });

  assert.deepEqual(await transport.rpc('machine-a', 'ui.tree', { visible_only: false }), {
    count: 2,
  });
  assert.deepEqual(captured, {
    file: '/fixture/vphone',
    args: ['guest', 'rpc', 'machine-a', 'ui.tree', '{"visible_only":false}'],
    timeoutMs: 1234,
    maxOutputBytes: 4567,
  });
});

test('RPC refusal preserves its typed guest code and sanitizes diagnostics', async () => {
  const transport = createVphoneTransport({
    execFile: async () =>
      result(
        JSON.stringify({
          ok: false,
          guest_error: { code: 'invalid_param', message: 'bad token=secret password="hidden"' },
        }),
        { error: new Error('exit 1') },
      ),
  });

  await assert.rejects(
    transport.rpc('machine-a', 'input.type', { text: 'do-not-echo' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.equal(
        (error as { details?: { vphoneCode?: string } }).details?.vphoneCode,
        'invalid_param',
      );
      assert.match((error as Error).message, /token=\[REDACTED\]/);
      assert.doesNotMatch((error as Error).message, /secret|hidden|do-not-echo/);
      return true;
    },
  );
});

test.each([
  ['malformed JSON', 'not-json'],
  ['non-object envelope', '[]'],
  ['missing ok', '{"result":{}}'],
  ['missing result', '{"ok":true}'],
])('RPC rejects %s without exposing response content', async (_name, stdout) => {
  const transport = createVphoneTransport({ execFile: async () => result(stdout) });
  await assert.rejects(transport.rpc('machine-a', 'device.info'), (error: unknown) => {
    assert.equal(
      (error as { details?: { reason?: string } }).details?.reason,
      'vphone_invalid_response',
    );
    assert.doesNotMatch((error as Error).message, /not-json|\[\]/);
    return true;
  });
});

test('a nonzero process without an envelope reports timeout', async () => {
  const transport = createVphoneTransport({
    execFile: async () => result('', { error: { killed: true, code: null } }),
  });
  await assert.rejects(transport.rpc('machine-a', 'device.info'), {
    details: { reason: 'vphone_command_timeout' },
  });
});

test('cancellation uses the shared canceled-request reason', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const transport = createVphoneTransport({
    execFile: async () => {
      called = true;
      return result('{"ok":true,"result":{}}');
    },
  });
  await assert.rejects(
    transport.json(['vm', 'list'], { signal: controller.signal }),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason === 'request_canceled',
  );
  assert.equal(called, false);
});

test('process errors do not leak CLI arguments and redact stderr', async () => {
  const transport = createVphoneTransport({
    execFile: async () => ({
      stdout: '',
      stderr: 'access_token=secret Bearer credential',
      error: new Error('exit 1'),
    }),
  });
  await assert.rejects(
    transport.json(['guest', 'send', 'machine', 'sensitive-input']),
    (error: unknown) => {
      assert.doesNotMatch((error as Error).message, /sensitive-input|secret|credential/);
      assert.match((error as Error).message, /\[REDACTED\]/);
      return true;
    },
  );
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 600_001])(
  'factory and per-call timeouts reject %s',
  async (timeoutMs) => {
    assert.throws(() => createVphoneTransport({ timeoutMs }), {
      code: 'INVALID_ARGS',
      details: {
        reason: 'vphone_transport_option_invalid',
        option: 'timeoutMs',
        maximum: 600_000,
      },
    });
    let calls = 0;
    const transport = createVphoneTransport({
      execFile: async () => {
        calls += 1;
        return result('[]');
      },
    });
    await assert.rejects(transport.json(['vm', 'list'], { timeoutMs }), {
      code: 'INVALID_ARGS',
      details: {
        reason: 'vphone_transport_option_invalid',
        option: 'timeoutMs',
        maximum: 600_000,
      },
    });
    assert.equal(calls, 0);
  },
);

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 16 * 1024 * 1024 + 1])(
  'factory output bounds reject %s',
  (maxOutputBytes) => {
    assert.throws(() => createVphoneTransport({ maxOutputBytes }), {
      code: 'INVALID_ARGS',
      details: {
        reason: 'vphone_transport_option_invalid',
        option: 'maxOutputBytes',
        maximum: 16 * 1024 * 1024,
      },
    });
  },
);
