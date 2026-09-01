import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PersistentFramedProcess } from './persistent-process.ts';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import type { SpikeRequest } from './types.ts';

function request(id: string): SpikeRequest {
  return {
    version: 1,
    id,
    candidate: 'guest-simulator-framework-bridge',
    simulatorUdid: 'simulator',
    state: 'warm',
    screen: 'quiet',
    appBundleId: 'com.callstack.agentdevicelab',
    limits: DEFAULT_SPIKE_LIMITS,
  };
}

test('keeps one framed reader alive across batches', async () => {
  let starts = 0;
  const worker = new PersistentFramedProcess({
    file: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      `
        import process from 'node:process';
        process.stdin.setEncoding('utf8');
        let buffer = '';
        process.stdin.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\\n');
          buffer = lines.pop() ?? '';
          for (const line of lines.filter(Boolean)) {
            const request = JSON.parse(line);
            process.stdout.write(JSON.stringify({
              version: 1,
              id: request.id,
              candidate: request.candidate,
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
                requestBytes: 1,
                responseBytes: 1,
                nodeCount: 1,
                maxTraversalDepth: 0,
                cpuMs: 1,
                memoryBytes: 1,
                durationMs: 1,
              },
            }) + '\\n');
          }
        });
      `,
    ],
    limits: { ...DEFAULT_SPIKE_LIMITS, maxDurationMs: 200 },
    beforeStart: async () => {
      starts += 1;
    },
  });

  const first = await worker.acquireBatch([request('one')]);
  const second = await worker.acquireBatch([request('two')]);
  await worker.close();

  assert.equal(first.responses[0]?.ok, true);
  assert.equal(second.responses[0]?.ok, true);
  assert.equal(starts, 1);
});
