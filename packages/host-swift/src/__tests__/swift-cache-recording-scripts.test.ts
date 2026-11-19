import { beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../tmp-dir.fixtures.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recordingScriptsDir = path.resolve(__dirname, '../../swift');
const recordingTestSupportDir = path.resolve(__dirname, '../../../../test/integration/support');
const SWIFT_TYPECHECK_TIMEOUT_MS = 60_000;

type TypecheckOutcome = { exitCode: number; stderr: string; source: string };

// The three `swiftc -typecheck` invocations run in beforeAll, not in the test bodies: each is a
// real compiler launch, and the unit slow-test gate budgets `packages/**` test cases far below one
// compile (see the budget note in docs/agents/testing.md). The snapshot-bridge and fold-helper
// gates in platform-apple keep their native compiles out of test-case wall time the same way.
// One beforeAll covers all three so the SDK probe and the two shared-source compiles are paid once
// per file rather than once per case.
describe.skipIf(process.platform !== 'darwin')('recording Swift scripts', () => {
  let outcomes: TypecheckOutcome[] = [];
  let exports: OverlayExportOutcome[] = [];
  let omissions: OmissionOutcome[] = [];

  beforeAll(
    async () => {
      const [compiler, sdk] = await Promise.all([
        runCmd('xcrun', ['--find', 'swiftc']),
        runCmd('xcrun', ['--show-sdk-path', '--sdk', 'macosx']),
      ]);
      const swiftCompilerPath = compiler.stdout.trim() || 'swiftc';
      const swiftSdkPath = sdk.stdout.trim();
      const sharedSupport = path.join(recordingScriptsDir, 'RecordingExportSupport.swift');
      const targets: Array<{ source: string; extraSources: string[] }> = [
        { source: path.join(recordingTestSupportDir, 'recording-inspect.swift'), extraSources: [] },
        {
          source: path.join(recordingScriptsDir, 'recording-overlay.swift'),
          extraSources: [sharedSupport],
        },
        {
          source: path.join(recordingScriptsDir, 'recording-frames.swift'),
          extraSources: [sharedSupport],
        },
      ];

      outcomes = await Promise.all(
        targets.map(async ({ source, extraSources }): Promise<TypecheckOutcome> => {
          const result = await runCmd(
            swiftCompilerPath,
            ['-sdk', swiftSdkPath, '-typecheck', source, ...extraSources],
            { allowFailure: true, timeoutMs: SWIFT_TYPECHECK_TIMEOUT_MS },
          );
          return { source, exitCode: result.exitCode, stderr: result.stderr };
        }),
      );
      const dir = await mkdtempForTest('recording-overlay-export-');
      const tools = await compileRecordingTools(
        swiftCompilerPath,
        swiftSdkPath,
        sharedSupport,
        dir,
      );
      exports = await exerciseOverlayExports(tools, dir);
      omissions = await exerciseOverlayReferenceOmission(tools, dir);
    },
    SWIFT_TYPECHECK_TIMEOUT_MS * 3 + 120_000,
  );

  test('recording inspect Swift script typechecks', () => {
    assertTypechecked(outcomes, 'recording-inspect.swift');
  });

  test('recording overlay Swift script typechecks', () => {
    assertTypechecked(outcomes, 'recording-overlay.swift');
  });

  test('recording frames Swift script typechecks', () => {
    assertTypechecked(outcomes, 'recording-frames.swift');
  });

  for (const transform of ['identity', 'rot90-negative-origin', 'rot90-translated']) {
    test(`overlay keeps upright content and touches for ${transform}`, () => {
      const outcome = exports.find((candidate) => candidate.transform === transform);
      assert.ok(outcome);
      assert.equal(outcome.exitCode, 0, outcome.stderr);
      assert.deepEqual(outcome.outputSize, outcome.sourceSize);
      assert.ok(outcome.sourceLuma! > 100);
      assert.ok(outcome.outputLuma! > 100, JSON.stringify(outcome));
      assert.equal(outcome.sourceBluePixels, 0, 'the fixture must not contain overlay colors');
      assert.ok(outcome.outputBluePixels! > 180, 'the touch overlay must actually draw');
      assert.ok(outcome.markerDistance! < 3, 'the asymmetric source marker must stay upright');
    });
  }

  test('overlay omits markers without a finite positive paired reference and keeps the raw video (#4448)', () => {
    for (const name of ['missing-reference', 'unpaired-reference', 'non-positive-reference']) {
      const outcome = omissions.find((candidate) => candidate.name === name);
      assert.ok(outcome, `${name} was never exercised`);
      assert.equal(outcome.exitCode, 0, outcome.stderr);
      assert.equal(
        outcome.byteIdentical,
        true,
        `${name}: omission must preserve the raw capture byte-for-byte`,
      );
      assert.equal(
        outcome.outputBluePixels,
        0,
        `${name}: no marker may be drawn from an unproven reference`,
      );
      assert.deepEqual(outcome.outputSize, outcome.sourceSize);
    }
  });

  test('overlay renders only the referenced events when others lack a reference (#4448)', () => {
    const outcome = omissions.find((candidate) => candidate.name === 'mixed');
    assert.ok(outcome, 'mixed was never exercised');
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.equal(
      outcome.byteIdentical,
      false,
      'a referenced event still forces the composited export',
    );
    assert.deepEqual(outcome.outputSize, outcome.sourceSize);
    assert.ok(outcome.outputBluePixels! > 180, 'the referenced marker must draw');
    assert.ok(
      outcome.outputBluePixels! <= 1500,
      `only the referenced marker may draw, saw ${outcome.outputBluePixels} overlay pixels`,
    );
  });
});

type OverlayExportOutcome = {
  transform: string;
  exitCode: number;
  stderr: string;
  sourceSize?: [number, number];
  outputSize?: [number, number];
  sourceLuma?: number;
  outputLuma?: number;
  sourceBluePixels?: number;
  outputBluePixels?: number;
  markerDistance?: number;
};

type RecordingToolBinaries = { overlay: string; fixture: string; inspect: string };

async function compileRecordingTools(
  compiler: string,
  sdk: string,
  sharedSupport: string,
  dir: string,
): Promise<RecordingToolBinaries> {
  const overlay = path.join(dir, 'overlay');
  const fixture = path.join(dir, 'fixture');
  const inspect = path.join(dir, 'inspect');
  await Promise.all(
    [
      [overlay, path.join(recordingScriptsDir, 'recording-overlay.swift'), sharedSupport],
      [fixture, path.join(recordingTestSupportDir, 'recording-overlay-fixture.swift')],
      [inspect, path.join(recordingTestSupportDir, 'recording-inspect.swift')],
    ].map(async ([output, ...sources]) => {
      await runCmd(compiler, ['-sdk', sdk, ...sources, '-o', output!], {
        timeoutMs: SWIFT_TYPECHECK_TIMEOUT_MS,
      });
    }),
  );
  return { overlay, fixture, inspect };
}

async function exerciseOverlayExports(tools: RecordingToolBinaries, dir: string) {
  const { overlay, fixture, inspect } = tools;
  const results: OverlayExportOutcome[] = [];
  for (const transform of ['identity', 'rot90-negative-origin', 'rot90-translated']) {
    const source = path.join(dir, `${transform}.mp4`);
    const output = path.join(dir, `${transform}-overlay.mp4`);
    const events = path.join(dir, `${transform}.json`);
    const [width, height] = transform === 'identity' ? [480, 640] : [640, 480];
    fs.writeFileSync(
      events,
      JSON.stringify({
        events: [
          {
            kind: 'tap',
            tMs: 150,
            x: width! / 2,
            y: height! / 2,
            referenceWidth: width,
            referenceHeight: height,
          },
        ],
      }),
    );
    await runCmd(fixture, [source, transform], { timeoutMs: 15_000 });
    const exported = await runCmd(
      overlay,
      ['--input', source, '--output', output, '--events', events],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    const outcome: OverlayExportOutcome = {
      transform,
      exitCode: exported.exitCode,
      stderr: exported.stderr,
    };
    if (exported.exitCode === 0) {
      const inspected = [];
      for (const [label, video] of [
        ['source', source],
        ['output', output],
      ]) {
        const inspectDir = path.join(dir, `${transform}-${label}`);
        await runCmd(inspect, ['--input', video!, '--events', events, '--output-dir', inspectDir], {
          timeoutMs: 15_000,
        });
        const manifest = JSON.parse(
          fs.readFileSync(path.join(inspectDir, 'manifest.json'), 'utf8'),
        );
        inspected.push({
          size: [manifest.renderWidth, manifest.renderHeight] as [number, number],
          pixels: inspectExportPixels(manifest.items[0].fullFramePath),
        });
      }
      const [raw, composited] = inspected;
      outcome.sourceSize = raw!.size;
      outcome.outputSize = composited!.size;
      outcome.sourceLuma = raw!.pixels.luma;
      outcome.outputLuma = composited!.pixels.luma;
      outcome.sourceBluePixels = raw!.pixels.bluePixels;
      outcome.outputBluePixels = composited!.pixels.bluePixels;
      outcome.markerDistance = Math.hypot(
        raw!.pixels.markerX - composited!.pixels.markerX,
        raw!.pixels.markerY - composited!.pixels.markerY,
      );
    }
    results.push(outcome);
  }
  return results;
}

type OmissionOutcome = {
  name: string;
  exitCode: number;
  stderr: string;
  byteIdentical?: boolean;
  sourceSize?: [number, number];
  outputSize?: [number, number];
  outputBluePixels?: number;
};

// #4448: an event without a finite, positive paired reference has no proven transform into the
// captured canvas. The overlay must omit only that marker — exit successfully, keep the capture's
// geometry, and (when nothing renders) keep the raw video byte-for-byte.
async function exerciseOverlayReferenceOmission(
  tools: RecordingToolBinaries,
  dir: string,
): Promise<OmissionOutcome[]> {
  const { overlay, fixture, inspect } = tools;
  const width = 480;
  const height = 640;
  const cases: Array<{ name: string; events: unknown[] }> = [
    {
      name: 'missing-reference',
      events: [{ kind: 'tap', tMs: 150, x: width / 2, y: height / 2 }],
    },
    {
      name: 'unpaired-reference',
      events: [{ kind: 'tap', tMs: 150, x: width / 2, y: height / 2, referenceWidth: width }],
    },
    {
      name: 'non-positive-reference',
      events: [
        {
          kind: 'tap',
          tMs: 150,
          x: width / 2,
          y: height / 2,
          referenceWidth: 0,
          referenceHeight: height,
        },
      ],
    },
    {
      name: 'mixed',
      events: [
        {
          kind: 'tap',
          tMs: 150,
          x: width / 2,
          y: height / 2,
          referenceWidth: width,
          referenceHeight: height,
        },
        { kind: 'tap', tMs: 150, x: 60, y: 80 },
      ],
    },
  ];

  const results: OmissionOutcome[] = [];
  for (const { name, events } of cases) {
    const source = path.join(dir, `${name}.mp4`);
    const output = path.join(dir, `${name}-overlay.mp4`);
    const eventsPath = path.join(dir, `${name}.json`);
    fs.writeFileSync(eventsPath, JSON.stringify({ events }));
    await runCmd(fixture, [source, 'identity'], { timeoutMs: 15_000 });
    const exported = await runCmd(
      overlay,
      ['--input', source, '--output', output, '--events', eventsPath],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    const outcome: OmissionOutcome = {
      name,
      exitCode: exported.exitCode,
      stderr: exported.stderr,
    };
    if (exported.exitCode === 0) {
      outcome.byteIdentical = fs.readFileSync(output).equals(fs.readFileSync(source));
      const inspectDir = path.join(dir, `${name}-inspect`);
      await runCmd(
        inspect,
        ['--input', output, '--events', eventsPath, '--output-dir', inspectDir],
        {
          timeoutMs: 15_000,
        },
      );
      const manifest = JSON.parse(fs.readFileSync(path.join(inspectDir, 'manifest.json'), 'utf8'));
      outcome.sourceSize = [width, height];
      outcome.outputSize = [manifest.renderWidth, manifest.renderHeight];
      outcome.outputBluePixels = inspectExportPixels(manifest.items[0].fullFramePath).bluePixels;
    }
    results.push(outcome);
  }
  return results;
}

function inspectExportPixels(framePath: string) {
  const png = PNG.sync.read(fs.readFileSync(framePath));
  let luma = 0;
  let bluePixels = 0;
  let markerPixels = 0;
  let markerX = 0;
  let markerY = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    const [r, g, b] = png.data.subarray(i * 4, i * 4 + 3);
    luma += 0.299 * r! + 0.587 * g! + 0.114 * b!;
    if (b! >= 180 && g! >= 160 && r! <= 235 && b! >= g! && b! - r! >= 25) bluePixels++;
    if (r! > 170 && g! < 100 && b! < 100) {
      markerPixels++;
      markerX += i % png.width;
      markerY += Math.floor(i / png.width);
    }
  }
  return {
    luma: luma / (png.width * png.height),
    bluePixels,
    markerX: markerX / markerPixels,
    markerY: markerY / markerPixels,
  };
}

function assertTypechecked(outcomes: readonly TypecheckOutcome[], basename: string): void {
  const outcome = outcomes.find((entry) => path.basename(entry.source) === basename);
  assert.ok(outcome, `${basename} was never typechecked`);
  assert.equal(outcome.exitCode, 0, `${basename} should typecheck\n${outcome.stderr}`);
}
