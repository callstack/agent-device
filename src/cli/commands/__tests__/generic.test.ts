import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createAgentDeviceClient } from '../../../client.ts';
import type { DaemonResponse } from '../../../kernel/contracts.ts';
import type { CliFlags } from '../../../utils/cli-flags.ts';
import type { ClientBackedCliCommandName } from '../../../command-catalog.ts';
import { runGenericClientBackedCommand } from '../generic.ts';

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('snapshot --level digest --json preserves the digest through the generic CLI path', async () => {
  const digest = { nodeCount: 3, refs: [{ ref: 'e1', label: 'Login' }], truncated: false };
  const client = createAgentDeviceClient(
    { session: 'qa', responseLevel: 'digest' },
    {
      transport: async (req): Promise<DaemonResponse> => {
        assert.equal(req.command, 'snapshot');
        return { ok: true, data: digest };
      },
    },
  );
  const flags = { json: true, responseLevel: 'digest' } as CliFlags;

  const out = await captureStdout(() =>
    runGenericClientBackedCommand({
      command: 'snapshot' as ClientBackedCliCommandName,
      positionals: [],
      flags,
      client,
    }),
  );
  const parsed = JSON.parse(out) as { success: boolean; data: Record<string, unknown> };

  assert.equal(parsed.success, true);
  // nodeCount/refs — the digest fields — are preserved, not collapsed by the
  // snapshot formatter that expects `nodes`.
  assert.deepEqual(parsed.data, digest);
});
