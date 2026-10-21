import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { withCapturedStdoutAsync } from '../../../__tests__/test-utils/stream-capture.ts';
import { createAgentDeviceClient } from '../../../agent-device-client.ts';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import { screenshotCommand, diffCommand } from '../screenshot.ts';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';

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

  const out = await withCapturedStdoutAsync(() =>
    screenshotCommand({ host: createTestHostEnvironment(), positionals: [], flags, client }),
  );
  const parsed = JSON.parse(out) as { success: boolean; data: Record<string, unknown> };

  assert.equal(parsed.success, true);
  // overlayCount and artifacts — the useful digest fields — are NOT dropped.
  assert.deepEqual(parsed.data, digest);
});

const CROP_WARNING =
  'CROP_PARTIAL_INTERSECTION: the selector frame extends past the captured image; the crop was clipped to the image frame';

test('screenshot surfaces response-level warnings under the summary', async () => {
  const full = { path: '/tmp/shot.png', width: 40, height: 20, warnings: [CROP_WARNING] };
  const client = clientReturning(full);
  const flags = { json: false } as CliFlags;

  const out = await withCapturedStdoutAsync(() =>
    screenshotCommand({ host: createTestHostEnvironment(), positionals: [], flags, client }),
  );

  assert.equal(out, `/tmp/shot.png (40x20)\n${CROP_WARNING}\n`);
});

test('screenshot --json carries response-level warnings in the data', async () => {
  const full = { path: '/tmp/shot.png', width: 40, height: 20, warnings: [CROP_WARNING] };
  const client = clientReturning(full);
  const flags = { json: true } as CliFlags;

  const out = await withCapturedStdoutAsync(() =>
    screenshotCommand({ host: createTestHostEnvironment(), positionals: [], flags, client }),
  );
  const parsed = JSON.parse(out) as { data: { path: string; warnings?: string[] } };

  assert.equal(parsed.data.path, '/tmp/shot.png');
  assert.deepEqual(parsed.data.warnings, [CROP_WARNING]);
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

  const out = await withCapturedStdoutAsync(() =>
    screenshotCommand({ host: createTestHostEnvironment(), positionals: [], flags, client }),
  );
  const parsed = JSON.parse(out) as {
    data: { path: string; width?: number; pixelDensity?: number };
  };

  assert.equal(parsed.data.path, '/tmp/shot.png');
  assert.equal(parsed.data.width, 402);
  assert.equal(parsed.data.pixelDensity, 1);
  assert.ok(!('overlayCount' in parsed.data));
});

test.each([false, true])(
  'diff screenshot CLI normalizes saved and live current images (live=%s)',
  async (live) => {
    const dir = mkdtempForTestSync('cli-diff-width-');
    const baseline = path.join(dir, 'baseline.png');
    const current = path.join(dir, 'current.png');
    const diff = path.join(dir, 'diff.png');
    fs.writeFileSync(baseline, PNG.sync.write(new PNG({ width: 2, height: 2 })));
    fs.writeFileSync(current, PNG.sync.write(new PNG({ width: 4, height: 6 })));
    let captures = 0;
    const client = createAgentDeviceClient(
      { session: 'qa' },
      {
        transport: async (req): Promise<DaemonResponse> => {
          assert.equal(req.command, 'screenshot');
          captures += 1;
          const out = req.positionals?.[0];
          assert.equal(typeof out, 'string');
          fs.copyFileSync(current, out!);
          return { ok: true, data: { path: out } };
        },
      },
    );
    const stdout = await withCapturedStdoutAsync(() =>
      diffCommand({
        host: createTestHostEnvironment(),
        positionals: ['screenshot', ...(live ? [] : [current])],
        flags: { json: true, baseline, out: diff, threshold: '1' } as CliFlags,
        client,
      }),
    );
    const { data } = JSON.parse(stdout);
    assert.equal(captures, live ? 1 : 0);
    assert.equal(data.differentPixels, 2);
    assert.equal(data.totalPixels, 6);
    assert.equal(data.mismatchPercentage, 33.33);
    assert.deepEqual(data.normalization.scaledCurrent, { width: 2, height: 3 });
    const image = PNG.sync.read(fs.readFileSync(diff));
    assert.deepEqual([image.width, image.height], [2, 3]);
  },
);
