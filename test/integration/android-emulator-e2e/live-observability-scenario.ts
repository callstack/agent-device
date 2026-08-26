import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { readDaemonInfo } from '../../../src/daemon/client/daemon-client-metadata.ts';
import { resolveDaemonPaths } from '../../../src/daemon/config.ts';
import {
  collectPagedEventTimeline,
  type EventTimelinePage,
} from '../live-device-e2e/event-timeline.ts';
import { assertMp4File, assertNonEmptyFile, assertWaitText } from './live-assertions.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;

export async function assertObservabilityAndArtifacts(context: LiveContext): Promise<void> {
  await runStep(context, 'open Android fixture for observability', [
    'open',
    context.appId,
    '--relaunch',
  ]);
  await assertWaitText(context, 'Agent Device Tester');
  await assertMetrics(context);
  await assertLogs(context);
  await assertTraceAndRecording(context);
  await assertBatchAndEvents(context);
  await assertArtifactInventory(context);
}

async function assertMetrics(context: LiveContext): Promise<void> {
  const perf = await runStep(context, 'read Android fixture memory metrics', [
    'perf',
    'memory',
    'sample',
  ]);
  const metrics = perf.json?.data?.metrics;
  assert.equal(metrics?.memory?.available, true, JSON.stringify(perf.json));
  assert.ok(Number(metrics?.memory?.totalPssKb) > 0, JSON.stringify(perf.json));
  assert.deepEqual(Object.keys(metrics ?? {}), ['memory']);
  verifyCommand(context, C.perf, 'Android PSS memory metrics are typed and numeric');
}

async function assertLogs(context: LiveContext): Promise<void> {
  const started = await runStep(context, 'start Android fixture logcat stream', ['logs', 'start']);
  assert.equal(started.json?.data?.started, true, JSON.stringify(started.json));
  assert.ok(fs.existsSync(String(started.json?.data?.path)), JSON.stringify(started.json));
  const inspected = await runStep(context, 'inspect Android fixture logcat stream', [
    'logs',
    'path',
  ]);
  assert.equal(inspected.json?.data?.active, true, JSON.stringify(inspected.json));
  assert.equal(inspected.json?.data?.backend, 'android', JSON.stringify(inspected.json));
  assert.ok(fs.existsSync(String(inspected.json?.data?.path)), JSON.stringify(inspected.json));
  const stopped = await runStep(context, 'stop Android fixture logcat stream', ['logs', 'stop']);
  assert.equal(stopped.json?.data?.stopped, true, JSON.stringify(stopped.json));
  verifyCommand(context, C.logs, 'Android logcat starts, exposes its path, and stops');
}

async function assertTraceAndRecording(context: LiveContext): Promise<void> {
  const tracePath = path.join(context.artifactDir, 'fixture.adtrace');
  // 0.7 of a viewport scrolls the quick actions off the top on the pixel_7 profile the
  // nightly lane pins; half a viewport puts the whole card on screen.
  await runStep(context, 'reveal Android quick actions before trace', ['scroll', 'down', '0.5']);
  await runStep(context, 'start Android interaction trace', ['trace', 'start', tracePath]);
  await runStep(context, 'trace Android visible mutation', ['press', 'id="home-open-catalog"']);
  await runStep(context, 'stop Android interaction trace', ['trace', 'stop', tracePath]);
  assertNonEmptyFile(tracePath, 'trace');
  verifyCommand(
    context,
    C.trace,
    'traced Android press writes non-empty diagnostics at requested path',
  );

  const recordingPath = path.join(context.artifactDir, 'fixture.mp4');
  await runStep(context, 'start short Android screen recording', [
    'record',
    'start',
    recordingPath,
    '--hide-touches',
  ]);
  await runStep(context, 'return to Android fixture home before recording', [
    'click',
    'label="Home"',
  ]);
  await runStep(context, 'restore Android fixture home scroll top', ['scroll', 'top']);
  await runStep(context, 'reveal Android quick actions before recording', [
    'scroll',
    'down',
    '0.7',
  ]);
  await runStep(context, 'record Android visible mutation', ['press', 'id="home-open-settings"']);
  await assertWaitText(context, 'Settings');
  await runStep(context, 'stop short Android screen recording', ['record', 'stop']);
  await assertMp4File(recordingPath);
  verifyCommand(context, C.record, 'short Android recording is a finalized playable MP4');
}

async function assertBatchAndEvents(context: LiveContext): Promise<void> {
  await runStep(context, 'return to Android fixture home before batch', ['click', 'label="Home"']);
  await runStep(context, 'restore Android fixture home title before batch', ['scroll', 'top']);
  await assertWaitText(context, 'Agent Device Tester');
  // Android snapshots only carry on-screen nodes, so both batch targets are revealed first.
  // 0.3 of a viewport is the band where the gesture lab card and the release notice below it
  // are on screen together on the pixel_7 profile the lane pins; by 0.4 the card is gone.
  await runStep(context, 'reveal Android batch targets', ['scroll', 'down', '0.3']);
  const batch = await runStep(context, 'run Android nested semantic read batch', [
    'batch',
    '--steps',
    JSON.stringify([
      {
        command: 'get',
        input: { format: 'text', target: { kind: 'selector', selector: 'id="dismiss-notice"' } },
      },
      {
        command: 'is',
        // A sibling card, not the notice that owns `dismiss-notice`: resolving a child already
        // proves its parent is present, so a parent target could not fail on its own.
        input: { predicate: 'visible', selector: 'id="gesture-lab-card"' },
      },
    ]),
  ]);
  const results = batch.json?.data?.results;
  assert.ok(
    Array.isArray(results),
    `batch must retain nested results: ${JSON.stringify(batch.json)}`,
  );
  assert.equal(results.length, 2, JSON.stringify(batch.json));
  assert.equal(results[0]?.command, 'get', JSON.stringify(batch.json));
  assert.equal(results[0]?.data?.text, 'Dismiss notice', JSON.stringify(batch.json));
  assert.equal(results[1]?.command, 'is', JSON.stringify(batch.json));
  assert.equal(results[1]?.data?.pass, true, JSON.stringify(batch.json));
  verifyCommand(context, C.batch, 'Android batch retains nested get and is evidence');

  await runStep(context, 'capture Android snapshot for the event timeline', ['snapshot']);
  const timeline = await collectPagedEventTimeline(async (cursor) => {
    const result = await runStep(
      context,
      cursor === undefined ? 'read Android event timeline' : `read Android events from ${cursor}`,
      // Each page read appends its own request events, so a page smaller than that tail
      // never catches up with a full-tier session's timeline.
      cursor === undefined ? ['events', '50'] : ['events', '50', cursor],
    );
    return (result.json?.data ?? {}) as EventTimelinePage;
  });
  assert.ok(timeline.pages.length > 1, JSON.stringify(timeline.pages));
  for (const command of [C.open, C.press, C.snapshot]) {
    assert.ok(
      timeline.commands.includes(command),
      `events missing ${command}: ${JSON.stringify(timeline)}`,
    );
  }
  verifyCommand(
    context,
    C.events,
    'paged Android event timeline includes open, press, and snapshot',
  );
}

async function assertArtifactInventory(context: LiveContext): Promise<void> {
  const inventory = await runStep(context, 'list Android daemon artifacts', ['artifacts']);
  const artifacts = inventory.json?.data?.artifacts;
  assert.ok(Array.isArray(artifacts), JSON.stringify(inventory.json));
  // Recordings are absent by design for local clients: record stop hands the MP4
  // to the caller's path directly (asserted above), and only remote clients get a
  // downloadable inventory entry. The trace is tracked unconditionally.
  const trace = artifacts.find(
    (artifact: { artifactType?: unknown; id?: unknown; sizeBytes?: unknown }) =>
      artifact.artifactType === 'trace-log' &&
      typeof artifact.id === 'string' &&
      Number(artifact.sizeBytes) > 0,
  ) as { id: string; sizeBytes: number } | undefined;
  assert.ok(trace, `trace artifact is not downloadable: ${JSON.stringify(artifacts)}`);
  const downloaded = await downloadDaemonArtifact(context, trace.id);
  assert.equal(
    downloaded.byteLength,
    trace.sizeBytes,
    'artifact download size must match inventory',
  );

  const afterDownload = await runStep(context, 'confirm downloaded artifact leaves inventory', [
    'artifacts',
  ]);
  const remaining = afterDownload.json?.data?.artifacts;
  assert.ok(Array.isArray(remaining), JSON.stringify(afterDownload.json));
  assert.equal(
    remaining.some((artifact: { id?: unknown }) => artifact.id === trace.id),
    false,
    'artifact download must consume its inventory entry',
  );
  verifyCommand(
    context,
    C.artifacts,
    'daemon inventory lists a non-empty trace artifact and its download consumes the entry',
  );
}

async function downloadDaemonArtifact(
  context: LiveContext,
  artifactId: string,
): Promise<ArrayBuffer> {
  const daemonPaths = resolveDaemonPaths(context.env.AGENT_DEVICE_STATE_DIR, {
    env: context.env,
    projectRoot: process.cwd(),
  });
  const daemon = readDaemonInfo(daemonPaths.infoPath);
  assert.ok(daemon?.httpPort, `daemon HTTP metadata unavailable at ${daemonPaths.infoPath}`);
  const response = await fetch(
    `http://127.0.0.1:${daemon.httpPort}/artifacts/${encodeURIComponent(artifactId)}`,
    { headers: { authorization: `Bearer ${daemon.token}` } },
  );
  if (response.status !== 200) {
    assert.fail(`artifact download failed: ${response.status} ${await response.text()}`);
  }
  return response.arrayBuffer();
}
