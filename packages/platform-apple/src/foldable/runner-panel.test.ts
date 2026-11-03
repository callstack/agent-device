import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { bindTestCommandHost } from '@agent-device/test-kit';
import { withAppleRunnerProvider } from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppError } from '@agent-device/kernel/errors';

vi.mock('../foldable/fold-helper-cache.ts', () => ({
  ensureFoldHelperBinary: vi.fn(async () => ({ path: '/cache/fold-helper' })),
}));
vi.mock('../core/devicectl.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/devicectl.ts')>()),
  runIosDevicectlJsonRequest: vi.fn(async () => ({
    ok: true as const,
    payload: { result: { displays: [] } },
  })),
}));

import { runIosDevicectlJsonRequest } from '../core/devicectl.ts';
import { runAppleRunnerCommand } from '../core/runner-client.ts';
import {
  recordingRunnerProvider,
  type RecordedRunnerCall,
} from '../__tests__/recording-runner-provider.ts';
import { isAppleFoldableSimulator } from './orientation.ts';
import { resolveRunnerRequestLitPanel } from './runner-panel.ts';
import { IOS_DEVICE, IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import {
  IPHONE_17_SINGLE_PANEL,
  IPHONE_DUO_CLOSED,
  IPHONE_DUO_OPEN,
} from '../__tests__/display-fixtures.ts';

bindTestCommandHost();

const mockPanelTable = vi.mocked(runIosDevicectlJsonRequest);

beforeEach(() => {
  mockPanelTable.mockReset();
  mockPanelTable.mockResolvedValue({ ok: true as const, payload: { result: { displays: [] } } });
});

/**
 * A fresh simulator id per case: the panel count is cached per simulator for the life of the
 * process, and that cache is one of the facts under test.
 */
let simulatorCount = 0;
function simulator(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  simulatorCount += 1;
  return { ...IOS_SIMULATOR, id: `${IOS_SIMULATOR.id}-${simulatorCount}`, ...overrides };
}

function answering(payload: unknown): void {
  mockPanelTable.mockImplementation(async () => ({ ok: true as const, payload }));
}

test('a multi-panel request names the lit panel in the units the runner compares a window against', async () => {
  answering(IPHONE_DUO_CLOSED);
  // A closed Duo lights its outer panel: 1398x2034 px at pointScale 3, which is the 466x678 the
  // runner finds as that panel's SpringBoard window.
  assert.deepEqual(await resolveRunnerRequestLitPanel(simulator(), {}), {
    displayId: 1,
    widthPt: 466,
    heightPt: 678,
  });
});

test('each request reads the panel table once, so a fold moves the surface', async () => {
  const device = simulator();
  answering(IPHONE_DUO_CLOSED);
  assert.equal((await resolveRunnerRequestLitPanel(device, {}))?.displayId, 1);
  assert.equal(mockPanelTable.mock.calls.length, 1, 'the panel count comes from the same read');
  answering(IPHONE_DUO_OPEN);
  assert.equal(
    (await resolveRunnerRequestLitPanel(device, {}))?.displayId,
    3,
    'an opened device must be asked again, not answered from the panel that just went dark',
  );
  assert.equal(mockPanelTable.mock.calls.length, 2);
});

test('a device with one panel sends no panel and is never asked again', async () => {
  const device = simulator();
  answering(IPHONE_17_SINGLE_PANEL);
  assert.equal(await resolveRunnerRequestLitPanel(device, {}), undefined);
  const reads = mockPanelTable.mock.calls.length;
  assert.equal(await resolveRunnerRequestLitPanel(device, {}), undefined);
  assert.equal(mockPanelTable.mock.calls.length, reads, 'one panel is hardware, probed once');
});

test('a panel table that would not answer is not asked again by the next request', async () => {
  const device = simulator();
  mockPanelTable.mockRejectedValue(new Error('devicectl does not report displays'));
  assert.equal(await resolveRunnerRequestLitPanel(device, {}), undefined);
  assert.equal(await resolveRunnerRequestLitPanel(device, {}), undefined);
  assert.equal(mockPanelTable.mock.calls.length, 1);
});

test('a cancelled panel-table read leaves the next request free to ask', async () => {
  const device = simulator();
  mockPanelTable.mockRejectedValueOnce(new Error('devicectl aborted by the caller'));
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await resolveRunnerRequestLitPanel(device, { signal: cancelled.signal }), undefined);
  answering(IPHONE_DUO_CLOSED);
  assert.equal((await resolveRunnerRequestLitPanel(device, {}))?.displayId, 1);
});

test('a multi-panel device whose panel power decides nothing sends no panel', async () => {
  const device = simulator();
  // Both panels lit: panel power settles no single panel, so the runner keeps its historic route.
  answering({
    result: {
      displays: IPHONE_DUO_CLOSED.result.displays.map((display) => ({
        ...display,
        active: true,
        backlightState: 'activeOn',
      })),
    },
  });
  assert.equal(await resolveRunnerRequestLitPanel(device, {}), undefined);
  answering(IPHONE_DUO_OPEN);
  assert.equal((await resolveRunnerRequestLitPanel(device, {}))?.displayId, 3);
  assert.equal(
    mockPanelTable.mock.calls.length,
    2,
    'ambiguous power does not cache a single-panel verdict',
  );
});

test('a multi-panel device whose panel table is incomplete sends no panel', async () => {
  const device = simulator();
  // The parser read one of two integrated panels, so the unread one may be the lit one.
  const [outer, inner] = IPHONE_DUO_CLOSED.result.displays;
  answering({
    result: {
      displays: [outer, { ...inner, nativeSize: undefined }],
    },
  });
  assert.equal(await resolveRunnerRequestLitPanel(device, {}), undefined);
  answering(IPHONE_DUO_OPEN);
  assert.equal((await resolveRunnerRequestLitPanel(device, {}))?.displayId, 3);
  assert.equal(mockPanelTable.mock.calls.length, 2, 'an incomplete table remains multi-panel');
});

test('a device the fold fact refuses never costs a panel table read', async () => {
  // A physical iPhone is folded by hand (ADR 0025) and no physical foldable leaf is in the
  // supported matrix, so its runner keeps the surface route the request always sent.
  assert.equal(await resolveRunnerRequestLitPanel(IOS_DEVICE, {}), undefined);
  assert.equal(mockPanelTable.mock.calls.length, 0);
});

test('a resolved read lifts the back-off a failed one opened', async () => {
  const device = simulator();
  mockPanelTable.mockRejectedValueOnce(new Error('devicectl does not report displays'));
  assert.equal(await resolveRunnerRequestLitPanel(device, {}), undefined);
  answering(IPHONE_DUO_CLOSED);
  // A rotation reads the table on its own route; its answer clears the back-off for surface reads.
  assert.equal(await isAppleFoldableSimulator(device, undefined), true);
  assert.equal((await resolveRunnerRequestLitPanel(device, {}))?.displayId, 1);
});

test('the probe takes the request timeout when it is the shorter one', async () => {
  answering(IPHONE_DUO_CLOSED);
  await resolveRunnerRequestLitPanel(simulator(), { requestTimeoutMs: 1_200 });
  assert.equal(mockPanelTable.mock.lastCall?.[0].timeoutMs, 1_200);
  await resolveRunnerRequestLitPanel(simulator(), { requestTimeoutMs: 60_000 });
  assert.equal(mockPanelTable.mock.lastCall?.[0].timeoutMs, 5_000);
});

test('a surface command probes the panel table within its own timeout', async () => {
  mockPanelTable.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { ok: true as const, payload: IPHONE_DUO_CLOSED };
  });
  const device = simulator({ name: 'iPhone Duo' });
  const calls: RecordedRunnerCall[] = [];
  await withAppleRunnerProvider(recordingRunnerProvider(calls), { deviceId: device.id }, () =>
    runAppleRunnerCommand(device, { command: 'tap', x: 10, y: 20, timeoutMs: 1_200 }),
  );
  assert.equal(mockPanelTable.mock.lastCall?.[0].timeoutMs, 1_200);
  assert.equal(calls[0]?.command.litPanel?.displayId, 1);
  const sentTimeoutMs = calls[0]?.command.timeoutMs ?? Number.NaN;
  assert.ok(sentTimeoutMs > 0 && sentTimeoutMs < 1_200, 'the runner gets what the read left');
});

test('a panel read that spends the whole request budget refuses instead of sending', async () => {
  mockPanelTable.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { ok: true as const, payload: IPHONE_DUO_CLOSED };
  });
  const device = simulator({ name: 'iPhone Duo' });
  const calls: RecordedRunnerCall[] = [];
  await assert.rejects(
    withAppleRunnerProvider(recordingRunnerProvider(calls), { deviceId: device.id }, () =>
      runAppleRunnerCommand(device, { command: 'tap', x: 10, y: 20, timeoutMs: 20 }),
    ),
    (error: AppError) => {
      assert.equal(error.details?.reason, 'panel-table-unreadable');
      assert.equal(error.details?.dispatched, 'no');
      return true;
    },
  );
  assert.equal(calls.length, 0, 'a request with no time left never reaches the runner');
});

test('a known multi-panel device refuses a surface command when its panel table goes unread', async () => {
  const device = simulator({ name: 'iPhone Duo' });
  const calls: RecordedRunnerCall[] = [];
  const run = () =>
    withAppleRunnerProvider(recordingRunnerProvider(calls), { deviceId: device.id }, () =>
      runAppleRunnerCommand(device, { command: 'tap', x: 10, y: 20 }),
    );
  answering(IPHONE_DUO_CLOSED);
  await run();
  assert.equal(calls[0]?.command.litPanel?.displayId, 1);

  mockPanelTable.mockRejectedValue(new Error('devicectl does not report displays'));
  await assert.rejects(run(), (error: AppError) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.details?.reason, 'panel-table-unreadable');
    assert.equal(error.details?.runnerErrorCode, 'APP_SCREEN_UNRESOLVED');
    assert.equal(error.details?.dispatched, 'no');
    return true;
  });
  assert.equal(calls.length, 1, 'the refused command never reached the runner');
});

test('a slow failed read does not back off over a newer read that resolved', async () => {
  const device = simulator();
  let failSlowRead!: (error: Error) => void;
  mockPanelTable.mockImplementationOnce(
    () => new Promise((_resolve, reject) => (failSlowRead = reject)),
  );
  const slow = resolveRunnerRequestLitPanel(device, {});
  answering(IPHONE_DUO_CLOSED);
  assert.equal((await resolveRunnerRequestLitPanel(device, {}))?.displayId, 1);
  failSlowRead(new Error('devicectl does not report displays'));
  assert.equal(await slow, undefined);
  assert.equal(
    (await resolveRunnerRequestLitPanel(device, {}))?.displayId,
    1,
    'the stale failure must not hold the next request on the historic route',
  );
});
