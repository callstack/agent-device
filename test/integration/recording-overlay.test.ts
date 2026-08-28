import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  analyzeOverlayCrop,
  createIntegrationTestContext,
  runCliJson,
  runRecordingInspect,
  type RecordingInspectionManifest,
} from './test-helpers.ts';

const recordingE2EEnabled = isTruthy(process.env.AGENT_DEVICE_RECORDING_E2E);

test('recording tap overlay on iOS simulator', { skip: shouldSkipIosRecordingE2E() }, () => {
  runRecordingOverlayCase({
    platform: 'ios',
    testName: 'recording tap overlay',
    outFile: 'ios-tap.mp4',
    sessionName: 'recording-ios-tap',
    openArgs: ['open', 'com.apple.Preferences', '--platform', 'ios', '--relaunch', '--json'],
    steps: [['tap general', ['click', 'role=cell', 'label=General', '--json']]],
    inspectPrefix: 'ios-tap',
    overlayKind: 'tap',
    overlayOptions: { minPixelCount: 180, maxCenterDistance: 80 },
  });
});

test('recording scroll overlay on iOS simulator', { skip: shouldSkipIosRecordingE2E() }, () => {
  runRecordingOverlayCase({
    platform: 'ios',
    testName: 'recording scroll overlay',
    outFile: 'ios-scroll.mp4',
    sessionName: 'recording-ios-scroll',
    openArgs: ['open', 'com.apple.Preferences', '--platform', 'ios', '--relaunch', '--json'],
    steps: [['scroll down', ['scroll', 'down', '0.45', '--json']]],
    inspectPrefix: 'ios-scroll',
    overlayKind: 'scroll',
    overlayOptions: { minPixelCount: 5 },
  });
});

test('recording back-swipe overlay on iOS simulator', { skip: shouldSkipIosRecordingE2E() }, () => {
  runRecordingOverlayCase({
    platform: 'ios',
    testName: 'recording back swipe overlay',
    outFile: 'ios-back-swipe.mp4',
    sessionName: 'recording-ios-back-swipe',
    openArgs: ['open', 'com.apple.Preferences', '--platform', 'ios', '--relaunch', '--json'],
    steps: [
      ['open general', ['press', '201', '319', '--json']],
      ['edge swipe', ['swipe', '10', '400', '250', '400', '250', '--json']],
    ],
    inspectPrefix: 'ios-back-swipe',
    overlayKind: 'back-swipe',
    overlayOptions: { minPixelCount: 80 },
  });
});

test('recording tap overlay on Android emulator', { skip: shouldSkipAndroidRecordingE2E() }, () => {
  runRecordingOverlayCase({
    platform: 'android',
    testName: 'recording tap overlay',
    outFile: 'android-tap.mp4',
    sessionName: 'recording-android-tap',
    openArgs: ['open', 'settings', '--platform', 'android', '--relaunch', '--json'],
    steps: [
      ['tap apps', ['press', '672', '1362', '--json']],
      ['scroll down', ['scroll', 'down', '0.2', '--json']],
      ['settle', ['wait', '1200', '--json']],
    ],
    inspectPrefix: 'android-tap',
    overlayKind: 'tap',
    overlayOptions: { minPixelCount: 180, maxCenterDistance: 80 },
  });
});

test(
  'recording scroll overlay on Android emulator',
  { skip: shouldSkipAndroidRecordingE2E() },
  () => {
    runRecordingOverlayCase({
      platform: 'android',
      testName: 'recording scroll overlay',
      outFile: 'android-scroll.mp4',
      sessionName: 'recording-android-scroll',
      openArgs: ['open', 'settings', '--platform', 'android', '--relaunch', '--json'],
      steps: [
        ['scroll down', ['scroll', 'down', '0.45', '--json']],
        ['settle', ['wait', '1200', '--json']],
      ],
      inspectPrefix: 'android-scroll',
      overlayKind: 'scroll',
      overlayOptions: { minPixelCount: 5 },
    });
  },
);

type RecordingOverlayCase = {
  platform: 'ios' | 'android';
  testName: string;
  outFile: string;
  sessionName: string;
  openArgs: string[];
  steps: Array<[string, string[]]>;
  inspectPrefix: string;
  overlayKind: string;
  overlayOptions: { minPixelCount: number; maxCenterDistance?: number };
};

function runRecordingOverlayCase(options: RecordingOverlayCase): void {
  const integration = createRecordingIntegrationContext(options.platform, options.testName);
  const outPath = path.join(integration.artifactDir(), options.outFile);
  const session = ['--session', options.sessionName];
  let recordingStarted = false;
  let recordingStopped = false;

  try {
    integration.runStep('open settings', [...options.openArgs, ...session]);
    integration.runStep('record start', ['record', 'start', outPath, '--json', ...session]);
    recordingStarted = true;
    for (const [label, args] of options.steps) {
      integration.runStep(label, [...args, ...session]);
    }
    const stop = integration.runStep('record stop', ['record', 'stop', '--json', ...session]);
    recordingStopped = true;
    assertRecordingArtifacts(stop, outPath);
    const manifest = inspectRecording(
      outPath,
      stop.json?.data?.telemetryPath,
      integration.artifactDir(),
      options.inspectPrefix,
    );
    assertOverlayForKind(manifest, options.overlayKind, options.overlayOptions);
  } finally {
    cleanupRecordingSession(integration, session, recordingStarted, recordingStopped);
  }
}

function createRecordingIntegrationContext(platform: 'ios' | 'android', testName: string) {
  const runId = new Date().toISOString().replaceAll(':', '-');
  const stateDir = path.resolve('test/artifacts', platform, sanitize(testName), runId, 'state');
  return createIntegrationTestContext({
    platform,
    testName,
    extraEnv: { ...process.env, AGENT_DEVICE_STATE_DIR: stateDir },
  });
}

function cleanupRecordingSession(
  integration: ReturnType<typeof createRecordingIntegrationContext>,
  session: string[],
  recordingStarted: boolean,
  recordingStopped: boolean,
): void {
  if (recordingStarted && !recordingStopped) {
    integration.runCleanupStep('cleanup record stop', ['record', 'stop', '--json', ...session]);
  }
  integration.runCleanupStep('cleanup close', ['close', '--json', ...session]);
}

function assertRecordingArtifacts(result: ReturnType<typeof runCliJson>, outPath: string): void {
  assert.equal(result.status, 0, JSON.stringify(result.json ?? result.stderr));
  assert.equal(result.json?.success, true);
  assert.equal(typeof result.json?.data?.telemetryPath, 'string');
  assert.ok(existsSync(outPath), `expected recording at ${outPath}`);
  assert.ok(
    existsSync(String(result.json?.data?.telemetryPath)),
    `expected telemetry sidecar at ${String(result.json?.data?.telemetryPath)}`,
  );
  assert.equal(
    result.json?.data?.artifacts?.some(
      (artifact: { field?: string }) => artifact.field === 'telemetryPath',
    ),
    true,
    'expected telemetryPath artifact in record stop response',
  );
}

function inspectRecording(
  outPath: string,
  telemetryPath: string,
  artifactDir: string,
  prefix: string,
): RecordingInspectionManifest {
  return runRecordingInspect({
    videoPath: outPath,
    telemetryPath,
    outputDir: path.join(artifactDir, `${prefix}-inspect`),
  });
}

function assertOverlayForKind(
  manifest: RecordingInspectionManifest,
  kind: string,
  options: { minPixelCount: number; maxCenterDistance?: number },
): void {
  const item = manifest.items.find((candidate) => candidate.kind === kind);
  assert.ok(item, `expected manifest item for ${kind}`);
  const analysis = analyzeOverlayCrop(item.cropPath);
  assert.ok(
    analysis.matchingPixelCount >= options.minPixelCount,
    `expected at least ${options.minPixelCount} overlay-colored pixels in ${item.cropPath}, saw ${analysis.matchingPixelCount}`,
  );
  if (options.maxCenterDistance === undefined) {
    return;
  }
  const centerX = analysis.width / 2;
  const centerY = analysis.height / 2;
  const distance = Math.hypot(analysis.centroidX - centerX, analysis.centroidY - centerY);
  assert.ok(
    distance <= options.maxCenterDistance,
    `expected overlay centroid near crop center for ${item.cropPath}, distance=${distance.toFixed(2)}`,
  );
}

function shouldSkipIosRecordingE2E(): string | false {
  if (!recordingE2EEnabled)
    return 'set AGENT_DEVICE_RECORDING_E2E=1 to run live recording overlay tests';
  if (process.platform !== 'darwin') return 'iOS recording overlay E2E runs only on macOS';
  return false;
}

function shouldSkipAndroidRecordingE2E(): string | false {
  if (!recordingE2EEnabled)
    return 'set AGENT_DEVICE_RECORDING_E2E=1 to run live recording overlay tests';
  return false;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
}

function sanitize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/-+/g, '-');
}
