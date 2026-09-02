import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runFramedBatch } from './framed-process.ts';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import type { SpikeRequest } from './types.ts';

function request(id: string): SpikeRequest {
  return {
    version: 1,
    id,
    candidate: 'guest-simulator-framework-bridge',
    simulatorUdid: '00000000-0000-0000-0000-000000000000',
    state: 'warm',
    screen: 'quiet',
    limits: DEFAULT_SPIKE_LIMITS,
  };
}

function childScript(mode: 'healthy' | 'delayed' | 'malformed' | 'crash' | 'hang'): {
  file: string;
  args: string[];
} {
  const payload = JSON.stringify({
    version: 1,
    ok: true,
    acquisition: {
      targetId: 'simulator:test',
      targetGeneration: 'generation-1',
      nodes: [{ id: 'n0', role: 'AXApplication' }],
      viewport: { kind: 'missing', reason: 'not-provided' },
      truncated: false,
      residue: [],
    },
    metrics: {
      requestBytes: 10,
      responseBytes: 10,
      nodeCount: 1,
      maxTraversalDepth: 0,
      cpuMs: 1,
      memoryBytes: 1,
      durationMs: 1,
    },
  });
  const malformed = payload.replace('"id":"n0"', '"id":"n0","hittable":true');
  const response = mode === 'malformed' ? malformed : payload;
  const script = `
    import process from 'node:process';
    if (${JSON.stringify(mode)} === 'crash') process.exit(17);
    if (${JSON.stringify(mode)} === 'hang') {
      setInterval(() => {}, 1000);
    } else {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', async () => {
      for (const line of input.split('\\n').filter(Boolean)) {
        const request = JSON.parse(line);
        if (${JSON.stringify(mode)} === 'delayed') await new Promise((resolve) => setTimeout(resolve, 100));
        process.stdout.write(JSON.stringify({ ...${response}, id: request.id, candidate: request.candidate }) + '\\n');
      }
    });
    }
  `;
  return { file: process.execPath, args: ['--input-type=module', '-e', script] };
}

test('uses one framed response per request and keeps diagnostics on stderr', async () => {
  const result = await runFramedBatch(childScript('healthy'), [request('one'), request('two')]);
  assert.deepEqual(
    result.responses.map((response) => response.id),
    ['one', 'two'],
  );
  assert.equal(
    result.responses.every((response) => response.ok),
    true,
  );
});

test('budgets a framed batch per request rather than timing the whole batch as one request', async () => {
  const result = await runFramedBatch(
    childScript('delayed'),
    [request('one'), request('two'), request('three')],
    { limits: { ...DEFAULT_SPIKE_LIMITS, maxDurationMs: 200 } },
  );
  assert.equal(
    result.responses.every((response) => response.ok),
    true,
  );
});

test('classifies malformed trees, crashes, timeouts, and cancellation', async () => {
  const malformed = await runFramedBatch(childScript('malformed'), [request('malformed')]);
  assert.equal(malformed.responses[0]?.failure?.kind, 'malformed-tree');

  const crashed = await runFramedBatch(childScript('crash'), [request('crash')]);
  assert.equal(crashed.responses[0]?.failure?.kind, 'process-crash');

  const timeout = await runFramedBatch(childScript('hang'), [request('timeout')], {
    limits: { ...DEFAULT_SPIKE_LIMITS, maxDurationMs: 40 },
  });
  assert.equal(timeout.responses[0]?.failure?.kind, 'timeout');

  const controller = new AbortController();
  const cancellation = runFramedBatch(childScript('hang'), [request('cancel')], {
    signal: controller.signal,
    limits: { ...DEFAULT_SPIKE_LIMITS, maxDurationMs: 200 },
  });
  setTimeout(() => controller.abort(), 10);
  const cancelled = await cancellation;
  assert.equal(cancelled.responses[0]?.failure?.kind, 'cancelled');

  const transport = await runFramedBatch(
    { file: '/private/tmp/agent-device-ios-ax-spike-missing-helper' },
    [request('transport')],
  );
  assert.equal(transport.responses[0]?.failure?.kind, 'transport-failure');
});
