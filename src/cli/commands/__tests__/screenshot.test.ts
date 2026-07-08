import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createAgentDeviceClient } from '../../../client/client.ts';
import type { DaemonResponse } from '../../../kernel/contracts.ts';
import type { CliFlags } from '../../parser/cli-flags.ts';
import { screenshotCommand } from '../screenshot.ts';

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

function clientReturning(
  data: Record<string, unknown>,
  responseLevel?: 'digest' | 'default' | 'full',
) {
  return createAgentDeviceClient(
    { session: 'qa', ...(responseLevel ? { responseLevel } : {}) },
    {
      transport: async (req): Promise<DaemonResponse> => {
        assert.equal(req.command, 'screenshot');
        return { ok: true, data };
      },
    },
  );
}

test('screenshot --level digest --json preserves the digest payload through the CLI', async () => {
  const digest = {
    path: '/tmp/shot.png',
    overlayCount: 2,
    overlayRefs: [{ ref: 'e1', label: 'Login' }],
    artifacts: [{ field: 'path', artifactType: 'screenshot', artifactId: 'a1' }],
  };
  const client = clientReturning(digest, 'digest');
  const flags = { json: true, responseLevel: 'digest' } as CliFlags;

  const out = await captureStdout(() => screenshotCommand({ positionals: [], flags, client }));
  const parsed = JSON.parse(out) as { success: boolean; data: Record<string, unknown> };

  assert.equal(parsed.success, true);
  // overlayCount and artifacts — the useful digest fields — are NOT dropped.
  assert.deepEqual(parsed.data, digest);
});

test('screenshot --json at the default level still emits normalized screenshot metadata', async () => {
  const full = {
    path: '/tmp/shot.png',
    width: 402,
    height: 874,
    logicalWidth: 402,
    logicalHeight: 874,
    pixelDensity: 1,
    overlayRefs: [{ ref: 'e1', label: 'Login', x: 0, y: 0, width: 10, height: 10 }],
  };
  const client = clientReturning(full);
  const flags = { json: true } as CliFlags;

  const out = await captureStdout(() => screenshotCommand({ positionals: [], flags, client }));
  const parsed = JSON.parse(out) as {
    data: { path: string; width?: number; pixelDensity?: number };
  };

  assert.equal(parsed.data.path, '/tmp/shot.png');
  assert.equal(parsed.data.width, 402);
  assert.equal(parsed.data.pixelDensity, 1);
  assert.ok(!('overlayCount' in parsed.data));
});
