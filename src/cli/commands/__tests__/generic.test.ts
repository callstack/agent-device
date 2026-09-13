import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { createAgentDeviceClient } from '../../../agent-device-client.ts';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { ClientBackedCliCommandName } from '../client-backed.ts';
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

test('replay human output keeps the composable warnings channel (#2560)', async () => {
  const dir = mkdtempForTestSync('agent-device-generic-replay-');
  const scriptPath = path.join(dir, 'flow.yaml');
  fs.writeFileSync(scriptPath, 'appId: com.example\n---\n- tapOn: "Sign in"\n');
  const client = createAgentDeviceClient(
    { session: 'qa' },
    {
      transport: async (req): Promise<DaemonResponse> => {
        assert.equal(req.command, 'replay');
        return {
          ok: true,
          data: {
            replayed: 3,
            healed: 0,
            session: 'qa',
            sessionActive: false,
            artifactPaths: [],
            warnings: ['Optional Maestro tapOn skipped at flow.yaml:line 12'],
            message: 'Replayed 3 steps in 9.1s',
          },
        };
      },
    },
  );

  const out = await captureStdout(() =>
    runGenericClientBackedCommand({
      command: 'replay' as ClientBackedCliCommandName,
      positionals: [scriptPath],
      flags: {} as CliFlags,
      client,
    }),
  );

  assert.match(out, /Replayed 3 steps in 9\.1s/);
  // The skipped optional step must be visible to the human reader, not only --json.
  assert.match(out, /Warning: Optional Maestro tapOn skipped at flow\.yaml:line 12/);
});
