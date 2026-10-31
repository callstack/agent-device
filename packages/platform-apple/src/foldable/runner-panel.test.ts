import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { bindTestCommandHost } from '@agent-device/test-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('../foldable/fold-helper-cache.ts', () => ({
  ensureFoldHelperBinary: vi.fn(async () => ({ path: '/cache/fold-helper' })),
}));
vi.mock('../core/devicectl.ts', () => ({
  runIosDevicectlJsonRequest: vi.fn(async () => ({
    ok: true as const,
    payload: { result: { displays: [] } },
  })),
}));

import { runIosDevicectlJsonRequest } from '../core/devicectl.ts';
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
  assert.deepEqual(await resolveRunnerRequestLitPanel(simulator(), undefined), {
    displayId: 1,
    widthPt: 466,
    heightPt: 678,
  });
});

test('each request reads the panel table once, so a fold moves the surface', async () => {
  const device = simulator();
  answering(IPHONE_DUO_CLOSED);
  assert.equal((await resolveRunnerRequestLitPanel(device, undefined))?.displayId, 1);
  assert.equal(mockPanelTable.mock.calls.length, 1, 'the panel count comes from the same read');
  answering(IPHONE_DUO_OPEN);
  assert.equal(
    (await resolveRunnerRequestLitPanel(device, undefined))?.displayId,
    3,
    'an opened device must be asked again, not answered from the panel that just went dark',
  );
  assert.equal(mockPanelTable.mock.calls.length, 2);
});

test('a device with one panel sends no panel and is never asked again', async () => {
  const device = simulator();
  answering(IPHONE_17_SINGLE_PANEL);
  assert.equal(await resolveRunnerRequestLitPanel(device, undefined), undefined);
  const reads = mockPanelTable.mock.calls.length;
  assert.equal(await resolveRunnerRequestLitPanel(device, undefined), undefined);
  assert.equal(mockPanelTable.mock.calls.length, reads, 'one panel is hardware, probed once');
});

test('a panel table that would not answer is not asked again by the next request', async () => {
  const device = simulator();
  mockPanelTable.mockRejectedValue(new Error('devicectl does not report displays'));
  assert.equal(await resolveRunnerRequestLitPanel(device, undefined), undefined);
  assert.equal(await resolveRunnerRequestLitPanel(device, undefined), undefined);
  assert.equal(mockPanelTable.mock.calls.length, 1);
});

test('a cancelled panel-table read leaves the next request free to ask', async () => {
  const device = simulator();
  mockPanelTable.mockRejectedValueOnce(new Error('devicectl aborted by the caller'));
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await resolveRunnerRequestLitPanel(device, cancelled.signal), undefined);
  answering(IPHONE_DUO_CLOSED);
  assert.equal((await resolveRunnerRequestLitPanel(device, undefined))?.displayId, 1);
});

test('a multi-panel device whose panel power decides nothing sends no panel', async () => {
  // Both panels lit: the panel table settles no single panel. `activeDisplay` still names the
  // primary panel for a capture, which has to name some display or refuse, but a surface fact is
  // not forced to guess, and naming the wrong one would have the runner refuse the panel the user
  // is looking at.
  answering({
    result: {
      displays: IPHONE_DUO_CLOSED.result.displays.map((display) => ({
        ...display,
        active: true,
        backlightState: 'activeOn',
      })),
    },
  });
  assert.equal(await resolveRunnerRequestLitPanel(simulator(), undefined), undefined);
});

test('a multi-panel device whose panel table is incomplete sends no panel', async () => {
  // The table named two integrated panels and the parser could read only one of them, so the
  // unread one may be the lit one. Its capture still names the parsed panel because a capture must
  // name a display or refuse; a surface fact is not allowed to book every gesture on a display that
  // can be dark.
  const [outer, inner] = IPHONE_DUO_CLOSED.result.displays;
  answering({
    result: {
      displays: [outer, { ...inner, nativeSize: undefined }],
    },
  });
  assert.equal(await resolveRunnerRequestLitPanel(simulator(), undefined), undefined);
});

test('a device the fold fact refuses never costs a panel table read', async () => {
  // A physical iPhone is folded by hand (ADR 0025) and no physical foldable leaf is in the
  // supported matrix, so its runner keeps the surface route the request always sent.
  assert.equal(await resolveRunnerRequestLitPanel(IOS_DEVICE, undefined), undefined);
  assert.equal(mockPanelTable.mock.calls.length, 0);
});
