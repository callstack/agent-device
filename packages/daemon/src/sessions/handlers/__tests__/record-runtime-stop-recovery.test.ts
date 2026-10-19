import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import {
  expectDecodedCompletedRecording,
  makeRecordRuntimeHarness,
  recordingResourcePath,
} from './record-runtime.fixtures.ts';

// The stop lane WITHOUT a held session resolves through the selection dispatch. The double acts
// like a multi-device host: it answers only requests that state the recorded identity (or the
// linux family), so a lane that swept the host's flags instead of resolving from the manifest
// gets the ambiguity such a host really returns.
const RESTART_RECORDED_DEVICE = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
} as const;
const APPLE_RECORDED_DEVICE = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'IOS-UDID-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
} as const;
const FLAGLESS_RECORDED_DEVICE = {
  platform: 'linux',
  id: 'linux',
  name: 'Linux',
  kind: 'device',
  target: 'desktop',
} as const;
const resolveTargetDeviceMock = vi.fn(async (flags: Record<string, string | undefined> = {}) => {
  if (flags.serial === RESTART_RECORDED_DEVICE.id || flags.udid === RESTART_RECORDED_DEVICE.id) {
    return { ...RESTART_RECORDED_DEVICE };
  }
  if (flags.udid === APPLE_RECORDED_DEVICE.id) return { ...APPLE_RECORDED_DEVICE };
  if (flags.platform === 'linux') return { ...FLAGLESS_RECORDED_DEVICE };
  throw new AppError('AMBIGUOUS_MATCH', 'Multiple attached devices detected');
});
vi.mock('@agent-device/device-selection/dispatch-resolve', () => ({
  resolveTargetDevice: (...args: unknown[]) =>
    resolveTargetDeviceMock(...(args as [Record<string, string> | undefined])),
}));

test('record stop after a daemon restart replays the completed export for the named session', async () => {
  // The #3674 state itself: sessions are memory-only, so a restart drops `recording`, while the
  // on-disk manifest survives. The caller still names the session (the only address that finds
  // the manifest at all), and `help record` promises the completed recording on that stop — even
  // on a host whose unconstrained resolution would answer AMBIGUOUS_MATCH.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-stop-');
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-restart-stop-output-'),
    'capture.mp4',
  );
  fs.writeFileSync(outPath, 'mp4');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the stopped recording session');
  harness.sessionStore.retire(ref);
  resolveTargetDeviceMock.mockClear();

  const recovered = await harness.run(['stop'], { sessionExplicit: true });

  expect(recovered).toMatchObject({
    ok: true,
    data: { recording: 'stopped', outPath, recordingBackend: 'adb screenrecord' },
  });
  // The recovery re-resolves the manifest's exact device, never an unconstrained sweep.
  expect(resolveTargetDeviceMock).toHaveBeenCalledWith(
    expect.objectContaining({ serial: 'emulator-5554' }),
  );
});

test('record stop recovery after a daemon restart keeps the request host-scoping selectors', async () => {
  // --android-device-allowlist says WHERE to look, not which device. A recovery that dropped it
  // would resolve (or fail) outside the allowlist the recording was started under.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-stop-scoping-');
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-restart-stop-scoping-output-'),
    'capture.mp4',
  );
  fs.writeFileSync(outPath, 'mp4');
  expect(
    await harness.run(['start', outPath], undefined, { androidDeviceAllowlist: 'emulator-5554' }),
  ).toMatchObject({ ok: true });
  expect(await harness.run(['stop'])).toMatchObject({ ok: true });
  expectDecodedCompletedRecording(harness.sessionStore, harness.sessionName);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the stopped recording session');
  harness.sessionStore.retire(ref);
  resolveTargetDeviceMock.mockClear();

  const recovered = await harness.run(
    ['stop'],
    { sessionExplicit: true },
    {
      androidDeviceAllowlist: 'emulator-5554',
    },
  );

  expect(recovered).toMatchObject({
    ok: true,
    data: { recording: 'stopped', outPath },
  });
  expect(resolveTargetDeviceMock).toHaveBeenCalledWith(
    expect.objectContaining({
      serial: 'emulator-5554',
      androidDeviceAllowlist: 'emulator-5554',
    }),
  );
});

test('record stop recovery on an Apple manifest keeps the request simulator-device-set', async () => {
  // The apple-family twin of the allowlist pin: --ios-simulator-device-set scopes where an Apple
  // recovery may look, and the identity it re-states is the udid.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-stop-ios-set-', {
    platform: 'apple',
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-restart-stop-ios-set-output-'),
    'capture.mp4',
  );
  fs.writeFileSync(outPath, 'mp4');
  expect(
    await harness.run(['start', outPath], undefined, { iosSimulatorDeviceSet: '/sets/qa.set' }),
  ).toMatchObject({ ok: true });
  expect(await harness.run(['stop'])).toMatchObject({ ok: true });
  expectDecodedCompletedRecording(harness.sessionStore, harness.sessionName);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the stopped recording session');
  harness.sessionStore.retire(ref);
  resolveTargetDeviceMock.mockClear();

  const recovered = await harness.run(
    ['stop'],
    { sessionExplicit: true },
    {
      iosSimulatorDeviceSet: '/sets/qa.set',
    },
  );

  expect(recovered).toMatchObject({ ok: true, data: { recording: 'stopped', outPath } });
  expect(resolveTargetDeviceMock).toHaveBeenCalledWith(
    expect.objectContaining({
      platform: 'apple',
      udid: 'IOS-UDID-1',
      iosSimulatorDeviceSet: '/sets/qa.set',
    }),
  );
});

test('record stop recovery carries the request lease and discovery context', async () => {
  // Lease fields say WHO may see the inventory, not WHICH device; a recovery that resolved
  // without them would look outside the lease the recording was started under.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-stop-lease-');
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-restart-stop-lease-output-'),
    'capture.mp4',
  );
  fs.writeFileSync(outPath, 'mp4');
  const leaseFlags = {
    leaseId: 'lease-1',
    leaseProvider: 'proxy',
    deviceKey: 'android:mobile:emulator-5554',
    clientId: 'client-1',
  };
  expect(await harness.run(['start', outPath], undefined, { ...leaseFlags })).toMatchObject({
    ok: true,
  });
  expect(await harness.run(['stop'])).toMatchObject({ ok: true });
  expectDecodedCompletedRecording(harness.sessionStore, harness.sessionName);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the stopped recording session');
  harness.sessionStore.retire(ref);
  resolveTargetDeviceMock.mockClear();

  const recovered = await harness.run(['stop'], { sessionExplicit: true }, { ...leaseFlags });

  expect(recovered).toMatchObject({ ok: true, data: { recording: 'stopped', outPath } });
  expect(resolveTargetDeviceMock).toHaveBeenCalledWith(expect.objectContaining(leaseFlags));
});

test('record stop recovery for a family without identity flags resolves under the manifest family', async () => {
  // A linux manifest names no identity flag the request could restate. The recovery still must
  // not sweep the host from the request's (empty) flags: it asks for the manifest's family, and
  // the double answers only such family-scoped requests.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-stop-flagless-', {
    platform: 'linux',
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-restart-stop-flagless-output-'),
    'capture.mp4',
  );
  fs.writeFileSync(outPath, 'mp4');
  expect(await harness.run(['start', outPath])).toMatchObject({ ok: true });
  expect(await harness.run(['stop'])).toMatchObject({ ok: true });
  expectDecodedCompletedRecording(harness.sessionStore, harness.sessionName);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the stopped recording session');
  harness.sessionStore.retire(ref);
  resolveTargetDeviceMock.mockClear();

  const recovered = await harness.run(['stop'], { sessionExplicit: true });

  expect(recovered).toMatchObject({ ok: true, data: { recording: 'stopped', outPath } });
  expect(resolveTargetDeviceMock).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'linux' }),
  );
});

test('record stop for a named session with no decodable manifest refuses on the session', async () => {
  // No manifest means there is nothing to recover from and nothing to take a device from: the
  // answer is the named-session refusal, and the host is never swept for a device.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-stop-no-manifest-');
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the published session');
  harness.sessionStore.retire(ref);

  const response = await harness.run(['stop'], { sessionExplicit: true });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'SESSION_NOT_FOUND', details: { reason: 'named_session_not_found' } },
  });
  expect(resolveTargetDeviceMock).not.toHaveBeenCalled();
});

test('a named stop recovery keeps failing closed when the manifest names another session', async () => {
  // The manifest-first lane reads the envelope before resolving, so the session proof must stay
  // on the served path: a manifest whose sessionId belongs to another address never answers.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-stop-cross-session-', {
    sessionName: 'recording-a',
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-restart-stop-cross-session-output-'),
    'capture.mp4',
  );
  fs.writeFileSync(outPath, 'mp4');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);
  const resourcePath = recordingResourcePath(harness.sessionStore, harness.sessionName);
  const record = screenRecordingResourceStore.read(resourcePath);
  if (record.status !== 'decoded') throw new Error('Expected decoded recording manifest');
  screenRecordingResourceStore.write(resourcePath, {
    ...record.envelope,
    sessionId: 'recording-b',
  });
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the stopped recording session');
  harness.sessionStore.retire(ref);

  const response = await harness.run(['stop'], { sessionExplicit: true });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'runtime-contract-invalid' } },
  });
});

test('record stop after a daemon restart answers an explicitly targeted request from its device', async () => {
  // The closest positive: the same unheld named session, but the request states the very device
  // the manifest names, so the selector lane serves the recovery — the stated target still wins.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-stop-targeted-');
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-restart-stop-targeted-output-'),
    'capture.mp4',
  );
  fs.writeFileSync(outPath, 'mp4');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the stopped recording session');
  harness.sessionStore.retire(ref);

  const recovered = await harness.run(
    ['stop'],
    { sessionExplicit: true },
    {
      platform: 'android',
      serial: 'emulator-5554',
    },
  );

  expect(recovered).toMatchObject({
    ok: true,
    data: { recording: 'stopped', outPath, recordingBackend: 'adb screenrecord' },
  });
});

test('record start after a daemon restart still refuses the named missing session', async () => {
  // The sibling direction of the restart pair: start has no manifest to recover, so the
  // named-session refusal keeps its priority for it.
  const harness = makeRecordRuntimeHarness('record-runtime-restart-start-');
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-restart-start-output-'),
    'capture.mp4',
  );
  await harness.run(['start', outPath]);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the live recording session');
  harness.sessionStore.retire(ref);
  resolveTargetDeviceMock.mockClear();

  const response = await harness.run(['start', outPath], { sessionExplicit: true });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'SESSION_NOT_FOUND', details: { reason: 'named_session_not_found' } },
  });
  expect(harness.runtime.start).toHaveBeenCalledOnce();
  // A start has no manifest to recover from, so the refusal answers before any device is sought.
  expect(resolveTargetDeviceMock).not.toHaveBeenCalled();
});

test('record stop with a live handle binds no runtime and terminalizes the durable record', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-live-stop-');
  const outPath = path.join(mkdtempForTestSync('record-runtime-live-stop-output-'), 'capture.mp4');
  await harness.run(['start', outPath]);

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({
    ok: true,
    data: { recording: 'stopped', outPath, recordingBackend: 'adb screenrecord' },
  });
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
  expect(harness.sessionStore.get(harness.sessionName)?.screenRecording).toBeUndefined();
});

test('record stop keeps a finish failure primary and preserves the recording for its retry', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-failed-live-stop-', {
    runtime: { finishError: new Error('final copy failed') },
  });
  await harness.run(['start', 'failed-copy.mp4']);

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({
    ok: false,
    error: { code: 'UNKNOWN', message: 'final copy failed' },
  });
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
  expect(harness.runtime.forceCleanup).not.toHaveBeenCalled();
  expect(harness.sessionStore.get(harness.sessionName)?.screenRecording).toBeDefined();
  expect(
    screenRecordingResourceStore.read(
      recordingResourcePath(harness.sessionStore, harness.sessionName),
    ),
  ).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'completing' } },
  });

  await expect(harness.run(['stop'])).resolves.toMatchObject({
    ok: false,
    error: { message: 'final copy failed' },
  });
  expect(harness.runtime.finish).toHaveBeenCalledTimes(2);
});

test('record stop after daemon-state loss reattaches only through the persisted exact owner', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-recovered-stop-', {
    runtime: { reattachActive: true },
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-recovered-stop-output-'),
    'capture.mp4',
  );
  await harness.run(['start', outPath]);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected adopted recording session');
  harness.sessionStore.update(ref, { screenRecording: undefined });

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({ ok: true, data: { recording: 'stopped', outPath } });
  expect(harness.runtime.bindExactDeviceCalls).toHaveBeenCalledOnce();
  expect(harness.runtime.reattach).toHaveBeenCalledOnce();
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
});

test('record stop terminalizes cleanup-only exact recovery without starting a replacement', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-cleanup-only-stop-', {
    recordOnlySession: true,
    runtime: { reattachUnreattachable: true },
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-cleanup-only-output-'),
    'capture.mp4',
  );
  await harness.run(['start', outPath]);
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected adopted recording session');
  harness.sessionStore.update(ref, { screenRecording: undefined });

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'transport-not-reattachable' } },
  });
  expect(harness.runtime.cleanup).toHaveBeenCalledOnce();
  expectDecodedCompletedRecording(harness.sessionStore, harness.sessionName);
  expect(harness.sessionStore.get(harness.sessionName)).toBeUndefined();
  expect(harness.runtime.start).toHaveBeenCalledOnce();
});

test('record stop rejects a cross-session recovery manifest before exact-owner binding', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-cross-session-', {
    sessionName: 'recording-a',
    runtime: { reattachActive: true },
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-cross-session-output-'),
    'capture.mp4',
  );
  await harness.run(['start', outPath]);
  const resourcePath = recordingResourcePath(harness.sessionStore, harness.sessionName);
  const record = screenRecordingResourceStore.read(resourcePath);
  if (record.status !== 'decoded') throw new Error('Expected decoded recording manifest');
  screenRecordingResourceStore.write(resourcePath, {
    ...record.envelope,
    sessionId: 'recording-b',
  });
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected adopted recording session');
  harness.sessionStore.update(ref, { screenRecording: undefined });

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'runtime-contract-invalid' } },
  });
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
});

test('record stop returns the export whose response never reached the caller', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-replayed-stop-');
  const outPath = writeRecording('record-runtime-replayed-stop-output-');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);

  const recovered = await harness.run(['stop']);

  expect(recovered).toMatchObject({
    ok: true,
    data: { recording: 'stopped', outPath, recordingBackend: 'adb screenrecord' },
  });
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
});

test('a recovered stop keeps the caller-side output path that makes it downloadable', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-replayed-remote-stop-');
  const cwd = mkdtempForTestSync('record-runtime-replayed-remote-stop-output-');
  const outPath = path.join(cwd, 'capture.mp4');
  fs.writeFileSync(outPath, 'mp4');
  await harness.run(['start', outPath], {
    cwd,
    clientArtifactPaths: { outPath: '/client/capture.mp4' },
  });
  await harness.run(['stop'], { cwd });

  const recovered = await harness.run(['stop'], { cwd });

  expect(recovered).toMatchObject({
    ok: true,
    data: {
      recording: 'stopped',
      outPath,
      artifacts: [{ field: 'outPath', path: outPath, localPath: '/client/capture.mp4' }],
    },
  });
});

test('a recovered stop does not record a second session stop action', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-replayed-stop-action-');
  const outPath = writeRecording('record-runtime-replayed-stop-action-output-');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);

  await harness.run(['stop']);

  const actions = harness.sessionStore.get(harness.sessionName)?.actions ?? [];
  expect(actions.filter((action) => action.positionals[0] === 'stop')).toHaveLength(1);
});

test('record stop reports no active recording once a completed export is gone', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-deleted-stop-');
  const outPath = writeRecording('record-runtime-deleted-stop-output-');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);
  fs.rmSync(outPath);

  const recovered = await harness.run(['stop']);

  expect(recovered).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: 'no active recording' },
  });
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
});

function writeRecording(prefix: string): string {
  const outPath = path.join(mkdtempForTestSync(prefix), 'capture.mp4');
  fs.writeFileSync(outPath, 'mp4');
  return outPath;
}

test('live record stop writes its action under the captured scoped address after rebuilding the record', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-scoped-stop-', {
    sessionName: 'cwd:0123456789abcdef:default',
  });
  harness.session.name = 'default';
  await expect(harness.run(['start', 'capture.mp4'])).resolves.toMatchObject({ ok: true });
  await expect(harness.run(['stop'])).resolves.toMatchObject({ ok: true });
  await harness.sessionStore.flushEvents();
  expect(
    harness.sessionStore
      .readEvents(harness.sessionName)
      .events.filter((event) => event.kind === 'action.recorded'),
  ).toHaveLength(2);
  expect(harness.sessionStore.readEvents('default').events).toEqual([]);
});
