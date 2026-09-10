import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('./core/tool-provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/tool-provider.ts')>();
  return { ...actual, runAppleToolCommand: vi.fn(actual.runAppleToolCommand) };
});

import { runAppleToolCommand } from './core/tool-provider.ts';
import { createSystemSurfacePresenceProbe } from './system-surface-presence.ts';

const mockRunCmd = vi.mocked(runAppleToolCommand);

const sim = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'UDID-1',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

type ProbeReply = { exitCode: number; stdout: string };

/** Routes the two probe commands independently so each failure mode can be exercised alone. */
function stubProbes(replies: { pgrep?: ProbeReply | Error; ps?: ProbeReply | Error }): void {
  mockRunCmd.mockImplementation(async (command: string) => {
    const reply = command === 'pgrep' ? replies.pgrep : replies.ps;
    if (reply === undefined) throw new Error(`unexpected probe command ${command}`);
    if (reply instanceof Error) throw reply;
    return { exitCode: reply.exitCode, stdout: reply.stdout, stderr: '' };
  });
}

const RUNNING = { exitCode: 0, stdout: '900\n' } as const;
const NOT_RUNNING = { exitCode: 1, stdout: '' } as const;
const scopedTo = (udid: string): ProbeReply => ({
  exitCode: 0,
  stdout: `/…/SafariViewService.app/SafariViewService SIMULATOR_UDID=${udid}`,
});

beforeEach(() => {
  vi.resetAllMocks();
});

test('a host process scoped to this device is present', async () => {
  stubProbes({ pgrep: RUNNING, ps: scopedTo('UDID-1') });
  await expect(createSystemSurfacePresenceProbe()(sim)).resolves.toBe('present');
});

test('the same host running for another device is absent', async () => {
  stubProbes({ pgrep: RUNNING, ps: scopedTo('OTHER') });
  await expect(createSystemSurfacePresenceProbe()(sim)).resolves.toBe('absent');
});

test('no host process at all is absent without reading any environment', async () => {
  stubProbes({ pgrep: NOT_RUNNING });
  await expect(createSystemSurfacePresenceProbe()(sim)).resolves.toBe('absent');
  expect(mockRunCmd).toHaveBeenCalledOnce();
});

test('a non-simulator is absent without probing', async () => {
  const probe = createSystemSurfacePresenceProbe();
  await expect(probe({ ...sim, kind: 'device' } as DeviceInfo)).resolves.toBe('absent');
  expect(mockRunCmd).not.toHaveBeenCalled();
});

// A probe that cannot answer must not be reported as absence: absence sends the capture to the AX
// bridge, which would answer confidently from the occluded app tree (#2438).
test('a failing process scan is unknown, never absent', async () => {
  stubProbes({ pgrep: new Error('pgrep unavailable') });
  await expect(createSystemSurfacePresenceProbe()(sim)).resolves.toBe('unknown');
});

test('an unreadable process environment is unknown, never absent', async () => {
  stubProbes({ pgrep: RUNNING, ps: new Error('ps failed') });
  await expect(createSystemSurfacePresenceProbe()(sim)).resolves.toBe('unknown');
});

// A successful read that carries no device scope at all proves nothing: reporting it as absence
// would route a live sheet to the occluded app tree.
test('a process environment with no device scope at all is unknown, never absent', async () => {
  stubProbes({
    pgrep: RUNNING,
    ps: { exitCode: 0, stdout: '/…/SafariViewService.app/SafariViewService' },
  });
  await expect(createSystemSurfacePresenceProbe()(sim)).resolves.toBe('unknown');
});

test('an empty process environment read is unknown, never absent', async () => {
  stubProbes({ pgrep: RUNNING, ps: { exitCode: 0, stdout: '' } });
  await expect(createSystemSurfacePresenceProbe()(sim)).resolves.toBe('unknown');
});

test('a non-zero process scan exit that is not "no match" is unknown', async () => {
  stubProbes({ pgrep: { exitCode: 2, stdout: '' } });
  await expect(createSystemSurfacePresenceProbe()(sim)).resolves.toBe('unknown');
});

// The regression thymikee named: a sheet opened right after an app capture must be seen by the very
// next capture, so absence is never memoized.
test('absence is not cached: a sheet opening within the TTL is seen immediately', async () => {
  let clock = 1_000;
  const probe = createSystemSurfacePresenceProbe(() => clock);
  stubProbes({ pgrep: NOT_RUNNING });
  await expect(probe(sim)).resolves.toBe('absent');

  stubProbes({ pgrep: RUNNING, ps: scopedTo('UDID-1') });
  clock += 10; // far inside the memo TTL
  await expect(probe(sim)).resolves.toBe('present');
});

test('unknown is not cached either', async () => {
  let clock = 1_000;
  const probe = createSystemSurfacePresenceProbe(() => clock);
  stubProbes({ pgrep: new Error('transient') });
  await expect(probe(sim)).resolves.toBe('unknown');

  stubProbes({ pgrep: RUNNING, ps: scopedTo('UDID-1') });
  clock += 10;
  await expect(probe(sim)).resolves.toBe('present');
});

test('a positive observation is memoized within the TTL and re-probed after it', async () => {
  let clock = 1_000;
  const probe = createSystemSurfacePresenceProbe(() => clock);
  stubProbes({ pgrep: RUNNING, ps: scopedTo('UDID-1') });
  await probe(sim);
  const callsAfterFirst = mockRunCmd.mock.calls.length;
  await expect(probe(sim)).resolves.toBe('present');
  expect(mockRunCmd.mock.calls.length).toBe(callsAfterFirst);

  clock += 2_000; // past the TTL
  stubProbes({ pgrep: NOT_RUNNING });
  await expect(probe(sim)).resolves.toBe('absent');
});
