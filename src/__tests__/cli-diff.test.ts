import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from '../utils/png.ts';
import type { DaemonResponse } from '../daemon/client/daemon-client.ts';
import {
  runCliCapture as captureCli,
  type CapturedCliRun,
  type CapturedDaemonRequest,
} from './cli-capture.ts';

type RunCliCaptureOptions = {
  preserveHome?: boolean;
};

/** Create a solid-color PNG buffer. */
function solidPngBuffer(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color.r;
    png.data[i + 1] = color.g;
    png.data[i + 2] = color.b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function runCliCapture(
  argv: string[],
  options: RunCliCaptureOptions = {},
): Promise<CapturedCliRun> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-home-'));

  const sendToDaemon = async (req: CapturedDaemonRequest): Promise<DaemonResponse> => {
    if (req.command === 'screenshot') {
      // The client-backed diff handler captures a screenshot via the client.
      // Write a real PNG to the requested path so compareScreenshots can read it.
      const outPath = req.positionals?.[0] ?? req.flags?.out;
      if (typeof outPath === 'string') {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));
      }
      return {
        ok: true,
        data: {
          path: outPath,
          ...(req.flags?.overlayRefs
            ? {
                overlayRefs: [
                  {
                    ref: 'e1',
                    label: 'Continue',
                    rect: { x: 1, y: 2, width: 3, height: 4 },
                    overlayRect: { x: 1, y: 2, width: 3, height: 4 },
                    center: { x: 3, y: 4 },
                  },
                ],
              }
            : {}),
        },
      };
    }
    return {
      ok: true,
      data: {
        mode: 'snapshot',
        baselineInitialized: false,
        summary: { additions: 1, removals: 1, unchanged: 1 },
        lines: [
          { kind: 'unchanged', text: '@e2 [window]' },
          { kind: 'removed', text: '  @e3 [text] "67"' },
          { kind: 'added', text: '  @e3 [text] "134"' },
        ],
      },
    };
  };

  try {
    return await captureCli(argv, sendToDaemon, {
      env: {
        HOME: options.preserveHome ? process.env.HOME : tempHome,
        FORCE_COLOR: '0',
        NO_COLOR: undefined,
      },
      passthroughBufferWrites: true,
    });
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

// Tests must run serially because they monkey-patch process.exit and process.stdout.write.
describe('cli diff commands', () => {
  test('diff snapshot renders human-readable unified diff text', async () => {
    const result = await runCliCapture(['diff', 'snapshot']);
    assert.equal(result.code, null);
    assert.equal(result.calls.length, 1);
    assert.match(result.stdout, /^@e2 \[window\]/m);
    assert.match(result.stdout, /^-  @e3 \[text\] "67"$/m);
    assert.match(result.stdout, /^\+  @e3 \[text\] "134"$/m);
    assert.match(result.stdout, /1 additions, 1 removals, 1 unchanged/);
    assert.equal(result.stderr, '');
  });

  test('diff snapshot --json passes daemon payload through unchanged', async () => {
    const result = await runCliCapture(['diff', 'snapshot', '--json']);
    assert.equal(result.code, null);
    assert.equal(result.calls.length, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, true);
    assert.equal(payload.data.mode, 'snapshot');
    assert.equal(payload.data.baselineInitialized, false);
    assert.equal(Array.isArray(payload.data.lines), true);
    assert.equal(result.stderr, '');
  });

  test('diff decline path falls through to generic diff validation', async () => {
    const result = await runCliCapture(['diff', 'unknown']);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    assert.match(result.stderr, /Only diff snapshot is available through this parser/);
    assert.doesNotMatch(result.stderr, /Unknown command: diff/);
  });

  test('snapshot --diff renders human-readable unified diff text', async () => {
    const result = await runCliCapture(['snapshot', '--diff']);
    assert.equal(result.code, null);
    assert.equal(result.calls.length, 1);
    const request = result.calls[0];
    assert.ok(request);
    assert.equal(request.command, 'diff');
    assert.deepEqual(request.positionals, ['snapshot']);
    assert.equal(request.flags?.snapshotDiff, undefined);
    assert.match(result.stdout, /^@e2 \[window\]/m);
    assert.match(result.stdout, /^-  @e3 \[text\] "67"$/m);
    assert.match(result.stdout, /^\+  @e3 \[text\] "134"$/m);
    assert.match(result.stdout, /1 additions, 1 removals, 1 unchanged/);
    assert.equal(result.stderr, '');
  });

  test('snapshot --diff --json passes daemon payload through unchanged', async () => {
    const result = await runCliCapture(['snapshot', '--diff', '--json']);
    assert.equal(result.code, null);
    assert.equal(result.calls.length, 1);
    const request = result.calls[0];
    assert.ok(request);
    assert.equal(request.command, 'diff');
    assert.deepEqual(request.positionals, ['snapshot']);
    assert.equal(request.flags?.snapshotDiff, undefined);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, true);
    assert.equal(payload.data.mode, 'snapshot');
    assert.equal(payload.data.baselineInitialized, false);
    assert.equal(Array.isArray(payload.data.lines), true);
    assert.equal(result.stderr, '');
  });

  test('diff screenshot renders human-readable mismatch output', async () => {
    // Create a real baseline PNG (black) so compareScreenshots can run against it.
    // The mock sendToDaemon writes a white PNG as the "current" screenshot.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-test-'));
    const baseline = path.join(dir, 'baseline.png');
    fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 0, g: 0, b: 0 }));

    try {
      const result = await runCliCapture([
        'diff',
        'screenshot',
        '--baseline',
        baseline,
        '--threshold',
        '0',
      ]);
      assert.equal(result.code, null);
      // Client-backed command sends a screenshot request to daemon
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0]!.command, 'screenshot');
      assert.match(result.stdout, /100% pixels differ/);
      assert.match(result.stdout, /100 different \/ 100 total pixels/);
      assert.equal(result.stdout.includes('Diff image:'), false);
      assert.equal(result.stderr, '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff screenshot --json outputs structured result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-test-'));
    const baseline = path.join(dir, 'baseline.png');
    // Same color as mock current screenshot → should match
    fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));

    try {
      const result = await runCliCapture(['diff', 'screenshot', '--baseline', baseline, '--json']);
      assert.equal(result.code, null);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.success, true);
      assert.equal(payload.data.match, true);
      assert.equal(payload.data.differentPixels, 0);
      assert.equal(payload.data.totalPixels, 100);
      assert.equal(payload.data.mismatchPercentage, 0);
      assert.equal(result.stderr, '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff screenshot sends screenshot capture request to daemon', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-test-'));
    const baseline = path.join(dir, 'baseline.png');
    fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));

    try {
      const result = await runCliCapture([
        'diff',
        'screenshot',
        '--baseline',
        baseline,
        '--overlay-refs',
        '--threshold',
        '0.2',
      ]);
      assert.equal(result.code, null);
      // The client-backed command captures a screenshot via the daemon client
      // and skips a second overlay capture when there is no diff to map.
      assert.equal(result.calls.length, 1);
      const call = result.calls[0]!;
      assert.equal(call.command, 'screenshot');
      assert.equal(result.stderr, '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff screenshot uses supplied current image instead of capturing from daemon', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-test-'));
    const baseline = path.join(dir, 'baseline.png');
    const current = path.join(dir, 'current.png');
    fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 0, g: 0, b: 0 }));
    fs.writeFileSync(current, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));

    try {
      const result = await runCliCapture([
        'diff',
        'screenshot',
        '--baseline',
        baseline,
        current,
        '--threshold',
        '0',
      ]);
      assert.equal(result.code, null);
      assert.equal(result.calls.length, 0);
      assert.match(result.stdout, /100% pixels differ/);
      assert.match(result.stdout, /100 different \/ 100 total pixels/);
      assert.equal(result.stderr, '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff screenshot rejects overlay refs with supplied current image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-test-'));
    const baseline = path.join(dir, 'baseline.png');
    const current = path.join(dir, 'current.png');
    fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 0, g: 0, b: 0 }));
    fs.writeFileSync(current, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));

    try {
      const result = await runCliCapture([
        'diff',
        'screenshot',
        '--baseline',
        baseline,
        current,
        '--overlay-refs',
      ]);
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 0);
      assert.match(result.stderr, /saved-image comparisons have no live accessibility refs/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff screenshot uses os.tmpdir for temporary current capture', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-test-'));
    const baseline = path.join(dir, 'baseline.png');
    fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));

    try {
      const result = await runCliCapture(['diff', 'screenshot', '--baseline', baseline]);
      assert.equal(result.code, null);
      assert.equal(result.calls.length, 1);
      const call = result.calls[0]!;
      assert.equal(call.command, 'screenshot');
      const capturePath = call.positionals?.[0];
      assert.equal(typeof capturePath, 'string');
      assert.equal(capturePath!.startsWith(os.tmpdir()), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff screenshot expands ~/ for baseline and out paths', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-home-'));
    const originalHome = process.env.HOME;
    const baselineRelative = path.join('fixtures', 'baseline.png');
    const diffRelative = path.join('fixtures', 'diff.png');
    const overlayRelative = path.join('fixtures', 'diff.current-overlay.png');
    const baseline = path.join(fakeHome, baselineRelative);
    const diffOut = path.join(fakeHome, diffRelative);
    const overlayOut = path.join(fakeHome, overlayRelative);

    fs.mkdirSync(path.dirname(baseline), { recursive: true });
    fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));
    fs.writeFileSync(diffOut, 'stale diff');
    fs.writeFileSync(overlayOut, 'stale overlay');
    process.env.HOME = fakeHome;

    try {
      const result = await runCliCapture(
        [
          'diff',
          'screenshot',
          '--baseline',
          `~/${baselineRelative}`,
          '--out',
          `~/${diffRelative}`,
          '--overlay-refs',
          '--json',
        ],
        { preserveHome: true },
      );

      assert.equal(result.code, null);
      assert.equal(result.calls.length, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.success, true);
      assert.equal(payload.data.match, true);
      assert.equal(fs.existsSync(diffOut), false);
      assert.equal(fs.existsSync(overlayOut), false);
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test('diff screenshot --overlay-refs writes a separate current overlay guide', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diff-test-'));
    const baseline = path.join(dir, 'baseline.png');
    const diffOut = path.join(dir, 'diff.png');
    const overlayOut = path.join(dir, 'diff.current-overlay.png');
    fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 0, g: 0, b: 0 }));

    try {
      const result = await runCliCapture([
        'diff',
        'screenshot',
        '--baseline',
        baseline,
        '--out',
        diffOut,
        '--overlay-refs',
        '--threshold',
        '0',
      ]);
      assert.equal(result.code, null);
      assert.equal(result.calls.length, 2);
      assert.equal(result.calls[0]?.command, 'screenshot');
      assert.equal(result.calls[0]?.flags?.overlayRefs, undefined);
      assert.equal(result.calls[1]?.command, 'screenshot');
      assert.equal(result.calls[1]?.flags?.overlayRefs, true);
      assert.equal(result.calls[1]?.positionals?.[0], overlayOut);
      assert.match(result.stdout, /Diff image:/);
      assert.match(result.stdout, /Current overlay:/);
      assert.match(result.stdout, /diff\.current-overlay\.png \(1 refs\)/);
      assert.match(
        result.stdout,
        /size=large shape=large-area density=100% avgColor=#000000->#ffffff luminance=0->255/,
      );
      assert.match(result.stdout, /overlaps @e1 "Continue", 12% of region/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
