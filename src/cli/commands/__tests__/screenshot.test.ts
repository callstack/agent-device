import { escapeTerminalText } from '@agent-device/kernel/redaction';
import {
  createTestHostEnvironment,
  mkdtempForTestSync,
  withCapturedStdoutAsync,
} from '@agent-device/test-kit';
import { onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createAgentDeviceClient } from '@agent-device/client';
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

  assert.equal(out, `/tmp/shot.png (40x20)\nWarning: ${CROP_WARNING}\n`);
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

// ADR 0016 (#4564): a capture whose remote script version did not arrive keeps its success, so the
// typed failure has to ride the machine view this command prints. `pickScreenshotResultData` narrows
// the capture payload for its own callers, so this command adds the disclosure itself.
test('screenshot --json carries a failed script delivery of the capture', async () => {
  const failure = {
    reason: 'script_delivery_failed',
    cause: 'script_write_failed',
    publicationId: '0f61b0c2-6d1a-4d1f-9b7f-2a4f3a1c7d55',
    message: 'The session recorded version 2, but the daemon could not save it.',
    hint: 'The file keeps the version from the last action that arrived.',
  };
  const client = clientReturning({
    path: '/tmp/shot.png',
    width: 40,
    height: 20,
    warnings: [failure.message],
    scriptDeliveryFailure: failure,
  });
  const flags = { json: true } as CliFlags;

  const out = await withCapturedStdoutAsync(() =>
    screenshotCommand({ host: createTestHostEnvironment(), positionals: [], flags, client }),
  );
  const parsed = JSON.parse(out) as {
    data: { path: string; warnings?: string[]; scriptDeliveryFailure?: unknown };
  };

  assert.deepEqual(parsed.data.scriptDeliveryFailure, failure);
  assert.deepEqual(parsed.data.warnings, [failure.message]);
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
          assert.equal(req.flags?.screenshotScreenMask, 'black');
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
        flags: {
          json: true,
          baseline,
          out: diff,
          threshold: '1',
          ...(live ? { screenshotScreenMask: 'black' } : {}),
        } as CliFlags,
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

test('the Node screenshot client sends the mask in its daemon request', async () => {
  const client = createAgentDeviceClient(
    { session: 'qa' },
    {
      transport: async (req): Promise<DaemonResponse> => {
        assert.equal(req.command, 'screenshot');
        assert.equal(req.flags?.screenshotScreenMask, 'black');
        return { ok: true, data: { path: '/tmp/masked.png' } };
      },
    },
  );
  const result = await client.capture.screenshot({ path: '/tmp/masked.png', screenMask: 'black' });
  assert.equal(result.path, '/tmp/masked.png');
});

const CONTROL_WARNING = 'The remote script could not be saved to /tmp/a\u001b[8mb\u009bc.ad.';
const ESCAPED_CONTROL_WARNING = String.raw`/tmp/a\u001b[8mb\u009bc.ad.`;

/** The characters the CLI writer would escape, by the writer's own rule. */
function rawControls(text: string): string[] {
  return [...text].filter((char) => escapeTerminalText(char) !== char);
}

test.each([
  { level: undefined, json: false },
  { level: 'full' as const, json: false },
])(
  'screenshot (level $level) writes one escaped warning and no raw control character',
  async ({ level, json }) => {
    const full = { path: '/tmp/shot.png', width: 40, height: 20, warnings: [CONTROL_WARNING] };
    const client = clientReturning(full, level);
    const flags = { json, ...(level ? { responseLevel: level } : {}) } as CliFlags;

    const out = await withCapturedStdoutAsync(() =>
      screenshotCommand({ host: createTestHostEnvironment(), positionals: [], flags, client }),
    );

    const shown =
      level === 'full' ? String.raw`/tmp/a\u001b[8mb\u009bc.ad.` : ESCAPED_CONTROL_WARNING;
    assert.equal(out.split(shown).length - 1, 1, out);
    assert.deepEqual(rawControls(out), []);
  },
);

test.each([false, true])(
  'snapshot diff (color %s) writes one escaped warning and keeps only its own color codes',
  async (color) => {
    const client = createAgentDeviceClient(
      { session: 'qa' },
      {
        transport: async (): Promise<DaemonResponse> => ({
          ok: true,
          data: {
            baselineInitialized: false,
            summary: { additions: 1, removals: 0, unchanged: 0 },
            lines: [{ kind: 'added', text: 'label \u001b[8mhidden' }],
            warnings: [CONTROL_WARNING],
          },
        }),
      },
    );
    const host = createTestHostEnvironment({
      env: color ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' },
    });
    // node:util styleText reads the process environment, not the host one.
    if (color) vi.stubEnv('FORCE_COLOR', '1');
    else vi.stubEnv('NO_COLOR', '1');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const out = await withCapturedStdoutAsync(() =>
      diffCommand({ host, positionals: ['snapshot'], flags: {} as CliFlags, client }),
    );

    assert.equal(out.split(ESCAPED_CONTROL_WARNING).length - 1, 1, out);
    assert.ok(out.includes(String.raw`label \u001b[8mhidden`), out);
    // With color on, the only control characters left are the color codes the formatter added.
    const colorCode = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g');
    const remaining = out.replaceAll(colorCode, '');
    assert.deepEqual(rawControls(remaining), []);
    assert.equal(out.includes('\u001b[8m'), false);
    assert.equal(new RegExp(colorCode.source).test(out), color, out);
  },
);

const MULTI_LINE_WARNING = 'Capture degraded\nretry with --raw';

test('screenshot folds a multi-line capture warning onto one line', async () => {
  const client = clientReturning({
    path: '/tmp/shot.png',
    width: 40,
    height: 20,
    warnings: [MULTI_LINE_WARNING],
  });

  const out = await withCapturedStdoutAsync(() =>
    screenshotCommand({
      host: createTestHostEnvironment(),
      positionals: [],
      flags: {} as CliFlags,
      client,
    }),
  );

  assert.ok(out.includes('Capture degraded retry with --raw'), out);
  assert.ok(!out.includes(MULTI_LINE_WARNING), out);
});

test('snapshot diff folds a multi-line notice onto one line', async () => {
  const client = createAgentDeviceClient(
    { session: 'qa' },
    {
      transport: async (): Promise<DaemonResponse> => ({
        ok: true,
        data: {
          baselineInitialized: false,
          summary: { additions: 0, removals: 0, unchanged: 0 },
          lines: [],
          warnings: [MULTI_LINE_WARNING],
        },
      }),
    },
  );

  const out = await withCapturedStdoutAsync(() =>
    diffCommand({
      host: createTestHostEnvironment(),
      positionals: ['snapshot'],
      flags: {} as CliFlags,
      client,
    }),
  );

  assert.ok(out.includes('Capture degraded retry with --raw'), out);
  assert.ok(!out.includes(MULTI_LINE_WARNING), out);
});
