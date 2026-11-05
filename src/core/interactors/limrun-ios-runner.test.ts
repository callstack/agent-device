import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  registerRequestAbort,
  markRequestCanceled,
  clearRequestCanceled,
  clearRequestAbortRegistration,
} from '@agent-device/host-kit/request';
import { expect, test, vi } from 'vitest';
import { fixture } from './limrun-ios-runner.fixtures.ts';
test('stops a stalled remote getenv when product preparation times out', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  try {
    const f = await fixture({ holdGetenv: true });
    const pending = f.runner.applicationTools.prewarmRunnerSession(
      f.device,
      {},
      new AbortController().signal,
      true,
      { healthCheck: false },
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() =>
      expect(f.session.client.simctl).toHaveBeenCalledWith(['getenv', 'booted', 'USE_IP']),
    );
    deadline.abort(new Error('deadline'));
    await rejected;
    expect(f.stopReadiness).toHaveBeenCalledOnce();
  } finally {
    timeout.mockRestore();
  }
});
test('stages a token-authenticated runner once and presents forwarded XCTest snapshots', async () => {
  const f = await fixture();
  const snapshot = await f.runner.createInteractor().snapshot({
    appBundleId: 'com.apple.Preferences',
    interactiveOnly: true,
  });
  expect(snapshot).toMatchObject({
    producer: 'apple-runner',
    backend: 'xctest',
    truncated: false,
    keyboard: { kind: 'absent' },
  });
  if (!('nodes' in snapshot)) throw new Error('Expected a presented snapshot');
  expect(snapshot.nodes?.map((n) => n.label)).toContain('Continue');
  expect(f.command).toMatchObject({
    command: 'snapshot',
    appBundleId: 'com.apple.Preferences',
    interactiveOnly: true,
  });
  expect(f.environment.BIND_IP).toBe('10.244.1.2');
  expect(f.environment.TOKEN?.length).toBeGreaterThanOrEqual(32);
  expect((f.manifest?.files.find((f) => f.path === 'Runner.app/Runner')?.mode ?? 0) & 0o111).toBe(
    0o111,
  );
  await f.runner.createInteractor().snapshot({ appBundleId: 'com.apple.Preferences' });
  expect(
    f.uploads.filter((m) => m.payloads.some((p) => p.path === 'Runner.app/Runner')),
  ).toHaveLength(1);
  expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(1);
  await f.runner.dispose();
  await expect(
    f.runner.createInteractor().snapshot({ appBundleId: 'com.apple.Preferences' }),
  ).rejects.toThrow();
});

test('reports an occupied XCTest slot instead of falling back to AX', async () => {
  const f = await fixture({ launchStatus: 409 });
  await expect(
    f.runner.createInteractor().snapshot({ appBundleId: 'com.apple.Preferences' }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun XCTest launch failed (409)',
  });
  expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(1);
});

test('rejects a forwarded response that does not prove runner token enforcement', async () => {
  const f = await fixture({ proof: false });
  await expect(
    f.runner.createInteractor().snapshot({ appBundleId: 'com.apple.Preferences' }),
  ).rejects.toMatchObject({
    details: { reason: 'runner_token_unsupported' },
  });
});

test('an admitted XCTest stream survives its launch deadline', async () => {
  const timeout = new AbortController();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timer = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) => (ms === 90_000 ? timeout.signal : realTimeout(ms)));
  try {
    const f = await fixture();
    const logPath = path.join(f.directory, 'runner.log');
    await f.runner.applicationTools.prepareRunner(
      f.device,
      { execution: { logPath }, timeoutMs: 5_000 },
      new AbortController().signal,
    );
    timeout.abort(new DOMException('Admission expired', 'TimeoutError'));
    f.testRun!.write('"still-alive"\n');
    await vi.waitFor(async () =>
      expect(await fs.readFile(logPath, 'utf8')).toContain('still-alive'),
    );
    expect(await f.runner.applicationTools.hasLiveRunnerSession(f.device, {})).toBe(true);
    expect(
      await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot(),
    ).toMatchObject({ backend: 'xctest' });
    expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(1);
  } finally {
    timer.mockRestore();
  }
});

test('a stalled rejection body respects the launch deadline and does not claim the occupied slot', async () => {
  const timeout = new AbortController();
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const readText = Response.prototype.text;
  const responseBody = vi
    .spyOn(Response.prototype, 'text')
    .mockImplementation(function (this: Response) {
      if (this.status === 409) markReadStarted();
      return readText.call(this);
    });
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timer = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) => (ms === 90_000 ? timeout.signal : realTimeout(ms)));
  try {
    const options = { launchStatus: 409, holdLaunchErrorBody: true };
    const f = await fixture(options);
    const prepare = () =>
      f.runner.applicationTools.prewarmRunnerSession(
        f.device,
        {},
        new AbortController().signal,
        true,
        { healthCheck: false },
      );
    const failed = expect(prepare()).rejects.toMatchObject({ details: { status: 409 } });
    await readStarted;
    timeout.abort(new DOMException('Admission expired', 'TimeoutError'));
    await failed;
    timer.mockRestore();
    options.holdLaunchErrorBody = false;
    await expect(prepare()).rejects.toMatchObject({ details: { status: 409 } });
    expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(2);
  } finally {
    timer.mockRestore();
    responseBody.mockRestore();
  }
});

test('an admission timeout waits for its uncertain XCTest slot before restarting', async () => {
  const timeout = new AbortController();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timer = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) => (ms === 90_000 ? timeout.signal : realTimeout(ms)));
  try {
    const options = { holdAdmission: true, canceledRunConflicts: 1 };
    const f = await fixture(options);
    const pending = f.runner.applicationTools.prewarmRunnerSession(
      f.device,
      {},
      new AbortController().signal,
      true,
      { healthCheck: false },
    );
    const failed = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.requests.some((p) => p.endsWith('/xctest/run'))).toBe(true));
    timeout.abort(new DOMException('Admission expired', 'TimeoutError'));
    await failed;
    await vi.waitFor(() => expect(f.admissionClosed).toBe(true));
    timer.mockRestore();
    options.holdAdmission = false;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const restarted = f.runner
      .createInteractor({ appBundleId: 'com.apple.Preferences' })
      .snapshot();
    await vi.waitFor(() =>
      expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(3),
    );
    expect(await restarted).toMatchObject({ producer: 'apple-runner', backend: 'xctest' });
  } finally {
    vi.useRealTimers();
    timer.mockRestore();
  }
});

test('cancels an in-flight snapshot while keeping the runner available for lease cleanup', async () => {
  const options = { holdSnapshot: false };
  const f = await fixture(options);
  const controller = new AbortController();
  const interactor = f.runner.createInteractor({
    signal: controller.signal,
    appBundleId: 'com.apple.Preferences',
  });
  await interactor.snapshot();
  options.holdSnapshot = true;
  const snapshot = interactor.snapshot();
  const outcome = expect(snapshot).rejects.toMatchObject({
    details: { reason: 'request_canceled' },
  });
  await vi.waitFor(() =>
    expect(f.commands.filter((command) => command.command === 'snapshot')).toHaveLength(2),
  );
  controller.abort(new Error('capture canceled'));
  await outcome;
  expect(await f.runner.applicationTools.hasLiveRunnerSession(f.device, {})).toBe(true);
  options.holdSnapshot = false;
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  await f.runner.dispose();
  expect(f.requests.filter((path) => path.endsWith('/xctest/run'))).toHaveLength(1);
});

test('an already canceled snapshot option does not start a cold runner', async () => {
  const f = await fixture();
  const signal = AbortSignal.abort(new Error('capture canceled'));
  await expect(
    f.runner.createInteractor().snapshot({ signal, appBundleId: 'com.apple.Preferences' }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'request_canceled' },
  });
  expect(f.requests).toHaveLength(0);
});

test('uses the request app instead of the XCTest target and refuses an unbound capture', async () => {
  const f = await fixture();
  expect(f.runner.facts.captureSnapshotWithoutActiveApp?.available).toBe(false);
  await expect(f.runner.createInteractor().snapshot()).rejects.toMatchObject({
    code: 'INVALID_ARGS',
  });
  expect(f.requests).toHaveLength(0);
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  expect(f.command?.appBundleId).toBe('com.apple.Preferences');
});

test('a failed target reset restarts the runner without re-uploading its products', async () => {
  const f = await fixture({ failReset: true });
  await f.runner.resetTarget();
  expect(f.requests).toHaveLength(0);
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  await expect(f.runner.resetTarget()).rejects.toMatchObject({
    details: { runnerErrorCode: 'RESET_FAILED' },
  });
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  expect(f.requests.filter((path) => path.endsWith('/xctest/run'))).toHaveLength(2);
  expect(
    f.uploads.filter((m) => m.payloads.some((p) => p.path === 'Runner.app/Runner')),
  ).toHaveLength(1);
});

test('cache prewarm uploads without starting XCTest, and retained close reuses the same run', async () => {
  const f = await fixture();
  const tools = f.runner.applicationTools;
  const signal = new AbortController().signal;
  await tools.prewarmRunnerCache(f.device, {}, signal);
  expect(
    f.uploads.filter((m) => m.payloads.some((p) => p.path === 'Runner.app/Runner')),
  ).toHaveLength(1);
  expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(0);
  await tools.prewarmRunnerSession(f.device, {}, signal, true);
  expect(await tools.hasLiveRunnerSession(f.device, {})).toBe(true);
  expect(await tools.releaseSpeculativeRunner(f.device, {})).toBe(true);
  expect(await tools.hasLiveRunnerSession(f.device, {})).toBe(false);
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  expect(await tools.releaseSpeculativeRunner(f.device, {})).toBe(false);
  await tools.releaseRunnerOnClose(f.device.id, { retain: true });
  expect(await tools.hasLiveRunnerSession(f.device, {})).toBe(true);
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(2);
  expect(
    f.uploads.filter((m) => m.payloads.some((p) => p.path === 'Runner.app/Runner')),
  ).toHaveLength(1);
  expect(await tools.detachRunnerSessionsForShutdown()).toEqual([]);
  expect(await tools.hasLiveRunnerSession(f.device, {})).toBe(false);
});

test.each(['launchStatus', 'syncStatus'] as const)(
  'a failed %s attempt can be retried on the same lease',
  async (failure) => {
    const options = { [failure]: 503 };
    const f = await fixture(options);
    await expect(
      f.runner.applicationTools.prewarmRunnerSession(
        f.device,
        {},
        new AbortController().signal,
        true,
      ),
    ).rejects.toThrow();
    options[failure] = 0;
    const result = await f.runner
      .createInteractor({ appBundleId: 'com.apple.Preferences' })
      .snapshot();
    expect(result).toMatchObject({ producer: 'apple-runner' });
    expect(
      f.requests.filter((p) => p.endsWith(failure === 'syncStatus' ? '/sync' : '/xctest/run')),
    ).toHaveLength(failure === 'syncStatus' ? 3 : 2);
  },
);

test('canceling shared lifecycle readiness stops the remote simctl execution', async () => {
  const f = await fixture({ holdReadiness: true });
  const controller = new AbortController();
  const lifecycle = f.runner.bindApplicationLifecycle({
    signal: controller.signal,
    clock: { now: Date.now, sleep: async () => {} },
    resolveInteractor: async () => f.runner.createInteractor(),
  });
  const pending = lifecycle.prepareApplicationOpen({
    execution: {},
    hasExistingSession: false,
    surface: 'app',
    prewarmRunnerOnColdBoot: false,
  });
  const outcome = expect(pending).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'request_canceled' },
  });
  controller.abort(new Error('readiness canceled'));
  await outcome;
  expect(f.stopReadiness).toHaveBeenCalledOnce();
  expect(f.requests).toHaveLength(0);
});

test('the shared connect loop waits through a forwarding gateway failure without replacing the run', async () => {
  const f = await fixture({ proxyHealthFailures: 1 });
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).tap(10, 20);
  expect(f.commands.filter((c) => c.command === 'uptime').length).toBeGreaterThanOrEqual(2);
  expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(1);
});

test('a lost mutation response is recovered from the runner journal without a second mutation', async () => {
  const f = await fixture({ loseTapReply: 'completed' });
  await expect(
    f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).tap(10, 20),
  ).resolves.toMatchObject({ recoveredTap: true });
  const tap = f.commands.filter((c) => c.command === 'tap');
  expect(tap).toHaveLength(1);
  expect(f.commands.find((c) => c.command === 'status')?.statusCommandId).toBe(tap[0]?.commandId);
  expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(1);
});

test('a lost mutation still executing is reported without replaying or replacing its runner', async () => {
  const f = await fixture({ loseTapReply: 'started' });
  await expect(
    f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).tap(10, 20),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'runner_reply_lost', lifecycleState: 'started' },
  });
  expect(f.commands.filter((c) => c.command === 'tap')).toHaveLength(1);
  expect(await f.runner.applicationTools.hasLiveRunnerSession(f.device, {})).toBe(true);
});

test('a busy mutation is neither replayed nor subjected to lost-response recovery', async () => {
  const f = await fixture({ busyTap: true });
  await expect(
    f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).tap(10, 20),
  ).rejects.toMatchObject({
    details: { runnerErrorCode: 'RUNNER_BUSY' },
  });
  expect(f.commands.filter((c) => c.command === 'tap')).toHaveLength(1);
  expect(f.commands.filter((c) => c.command === 'status')).toHaveLength(0);
});

test('a restarted generation rejects delayed requests carrying the previous token', async () => {
  const f = await fixture();
  const interactor = f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' });
  await interactor.snapshot();
  const previousToken = f.environment.TOKEN;
  await f.runner.applicationTools.stopRunnerSession(f.device.id);
  await interactor.snapshot();
  expect(f.environment.TOKEN).not.toBe(previousToken);
  const response = await fetch(
    new URL(`../targetHttpPort${f.environment.PORT}/command`, `${f.apiUrl}/`),
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer instance-token',
        'X-Agent-Device-Runner-Token': previousToken!,
      },
      body: JSON.stringify({ command: 'tap', x: 10, y: 20 }),
    },
  );
  expect(response.status).toBe(403);
  expect(f.commands.filter((c) => c.command === 'tap')).toHaveLength(0);
  expect(
    f.uploads.filter((m) => m.payloads.some((p) => p.path.startsWith('Runner.app/'))),
  ).toHaveLength(1);
  expect(
    f.uploads
      .slice(1)
      .every((m) => m.payloads.length === 1 && m.payloads[0]?.path === 'Runner.xctestrun'),
  ).toBe(true);
});

test.each(['signal', 'requestId'] as const)(
  'hard cancellation through %s waits for the canceled XCTest slot before restarting',
  async (via) => {
    const options = { holdAdmission: true, canceledRunConflicts: 1 };
    const f = await fixture(options);
    const controller = new AbortController();
    const requestId = 'limrun-cold-cancel';
    const registration = via === 'requestId' ? registerRequestAbort(requestId) : undefined;
    try {
      const pending = f.runner
        .createInteractor({
          appBundleId: 'com.apple.Preferences',
          ...(via === 'signal' ? { signal: controller.signal } : { requestId }),
        })
        .snapshot();
      const outcome = expect(pending).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'request_canceled' },
      });
      await vi.waitFor(() => expect(f.requests.some((p) => p.endsWith('/xctest/run'))).toBe(true));
      if (via === 'signal') controller.abort(new Error('stop cold launch'));
      else markRequestCanceled(requestId);
      await outcome;
      await vi.waitFor(() => expect(f.admissionClosed).toBe(true));
      const port = f.environment.PORT;
      options.holdAdmission = false;
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const restarted = f.runner
        .createInteractor({ appBundleId: 'com.apple.Preferences' })
        .snapshot();
      await vi.waitFor(() =>
        expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(3),
      );
      expect(await restarted).toMatchObject({ producer: 'apple-runner', backend: 'xctest' });
      expect(f.environment.PORT).toBe(port);
    } finally {
      vi.useRealTimers();
      clearRequestCanceled(requestId);
      clearRequestAbortRegistration(registration);
    }
  },
);

test('a caller deadline leaves its pending launch available for the next request', async () => {
  const f = await fixture({ holdAdmission: true });
  const controller = new AbortController();
  const pending = f.runner
    .createInteractor({ appBundleId: 'com.apple.Preferences', signal: controller.signal })
    .snapshot();
  const outcome = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.requests.some((p) => p.endsWith('/xctest/run'))).toBe(true));
  controller.abort(new DOMException('deadline', 'TimeoutError'));
  await outcome;
  expect(f.admissionClosed).toBe(false);
  f.admit();
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(1);
});

test('a never-ready generation expires across caller-deadline polls', async () => {
  const options = { holdSnapshot: true };
  const f = await fixture(options);
  const controller = new AbortController();
  const pending = f.runner
    .createInteractor({ appBundleId: 'com.apple.Preferences', signal: controller.signal })
    .snapshot();
  const outcome = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.command?.command).toBe('snapshot'));
  controller.abort(new DOMException('poll deadline', 'TimeoutError'));
  await outcome;
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  try {
    options.holdSnapshot = false;
    await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
    expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(2);
  } finally {
    now.mockRestore();
  }
});

test('an exact-session prepare after retirement cannot start a replacement', async () => {
  const f = await fixture();
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  await f.runner.applicationTools.stopRunnerSession(f.device.id);
  const execution = {
    requestId: 'retired-exact-prepare',
    expectedRunnerSessionId: 'retired-generation',
  };
  await expect(
    f.runner.applicationTools.prepareRunner(
      f.device,
      { execution, timeoutMs: 1000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    details: { reason: 'runner_session_ownership_changed' },
  });
  expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(1);
});

test('retained runners expire with the shared idle policy and restart from uploaded products', async () => {
  const f = await fixture({ idleMs: 1_000 });
  const interactor = f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' });
  await interactor.snapshot();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    await f.runner.applicationTools.releaseRunnerOnClose(f.device.id, { retain: true });
    await vi.advanceTimersByTimeAsync(1_001);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() =>
    expect(f.commands.some((command) => command.command === 'shutdown')).toBe(true),
  );
  await interactor.snapshot();
  expect(f.requests.filter((request) => request.endsWith('/xctest/run'))).toHaveLength(2);
  expect(
    f.uploads.filter((upload) =>
      upload.payloads.some((payload) => payload.path === 'Runner.app/Runner'),
    ),
  ).toHaveLength(1);
});

test('prewarming without a health check admits XCTest without sending commands', async () => {
  const f = await fixture();
  await f.runner.applicationTools.prewarmRunnerSession(
    f.device,
    {},
    new AbortController().signal,
    true,
    { healthCheck: false },
  );
  expect(f.requests.filter((request) => request.endsWith('/xctest/run'))).toHaveLength(1);
  expect(f.commands).toHaveLength(0);
  expect(await f.runner.applicationTools.releaseSpeculativeRunner(f.device, {})).toBe(true);
});

test('an exited test stream saves its result frames and the shared owner replaces the generation', async () => {
  const f = await fixture();
  const logPath = path.join(f.directory, 'runner.log');
  await f.runner.applicationTools.prepareRunner(
    f.device,
    { execution: { logPath }, timeoutMs: 5_000 },
    new AbortController().signal,
  );
  await f.runner.applicationTools.releaseRunnerOnClose(f.device.id, { retain: true });
  f.testRun?.end('"test-plan-failed"\n');
  await vi.waitFor(async () =>
    expect(await f.runner.applicationTools.hasLiveRunnerSession(f.device, {})).toBe(false),
  );
  await expect(
    f.runner.applicationTools.prepareRunner(
      f.device,
      { execution: {}, timeoutMs: 5_000 },
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ runner: { uptime: 1 } });
  expect(await fs.readFile(logPath, 'utf8')).toContain('test-plan-failed');
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  expect(f.requests.filter((request) => request.endsWith('/xctest/run'))).toHaveLength(2);
});

test('a close fences preparation already queued behind runner shutdown', async () => {
  const f = await fixture({ holdShutdown: true });
  await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
  const stopped = f.runner.applicationTools.stopRunnerSession(f.device.id);
  await vi.waitFor(() => expect(f.commands.at(-1)?.command).toBe('shutdown'));
  const preparing = f.runner.applicationTools.prepareRunner(
    f.device,
    { execution: {}, timeoutMs: 10_000 },
    new AbortController().signal,
  );
  const outcome = expect(preparing).rejects.toMatchObject({
    details: { reason: 'request_canceled', runnerStartRetired: true },
  });
  const closed = f.runner.applicationTools.releaseRunnerOnClose(f.device.id, { retain: false });
  f.testRun?.end();
  await Promise.all([stopped, closed, outcome]);
  expect(f.requests.filter((request) => request.endsWith('/xctest/run'))).toHaveLength(1);
});

test('close cancels a pending launch before waiting for the session lock', async () => {
  const f = await fixture({ holdAdmission: true });
  const preparing = f.runner.applicationTools.prepareRunner(
    f.device,
    { execution: {}, timeoutMs: 10_000 },
    new AbortController().signal,
  );
  const outcome = expect(preparing).rejects.toMatchObject({
    details: { reason: 'request_canceled', runnerStartRetired: true },
  });
  await vi.waitFor(() => expect(f.requests.some((p) => p.endsWith('/xctest/run'))).toBe(true));
  await f.runner.applicationTools.releaseRunnerOnClose(f.device.id, { retain: false });
  await outcome;
  await vi.waitFor(() => expect(f.admissionClosed).toBe(true));
});

test.each(['stopRunnerSession', 'finalizeRunnerSessionsForShutdown'] as const)(
  '%s cancels a pending launch before waiting for the session lock',
  async (operation) => {
    const options = { holdAdmission: true };
    const f = await fixture(options);
    const preparing = f.runner.applicationTools.prepareRunner(
      f.device,
      { execution: {}, timeoutMs: 10_000 },
      new AbortController().signal,
    );
    const outcome = expect(preparing).rejects.toMatchObject({
      details: { reason: 'request_canceled', runnerStartRetired: true },
    });
    await vi.waitFor(() => expect(f.requests.some((p) => p.endsWith('/xctest/run'))).toBe(true));
    if (operation === 'stopRunnerSession')
      await f.runner.applicationTools.stopRunnerSession(f.device.id);
    else await f.runner.applicationTools.finalizeRunnerSessionsForShutdown();
    await outcome;
    await vi.waitFor(() => expect(f.admissionClosed).toBe(true));
    options.holdAdmission = false;
    await f.runner.createInteractor({ appBundleId: 'com.apple.Preferences' }).snapshot();
    expect(f.requests.filter((p) => p.endsWith('/xctest/run'))).toHaveLength(2);
  },
);
