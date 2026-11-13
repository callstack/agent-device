import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockIsProcessAlive, mockIsProcessZombie, mockReadProcessStartTime } = vi.hoisted(() => ({
  mockIsProcessAlive: vi.fn(),
  mockIsProcessZombie: vi.fn(),
  mockReadProcessStartTime: vi.fn(),
}));

vi.mock('./host-process.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./host-process.ts')>()),
  isProcessAlive: mockIsProcessAlive,
  isProcessZombie: mockIsProcessZombie,
  readProcessStartTime: mockReadProcessStartTime,
  // The classification consumes one snapshot, so the fixture answers it from
  // the same state as the per-field probes and drops rows whose start time the
  // host could not read.
  readHostProcessIdentityObservations: (pids: Iterable<number>) => {
    const observations = new Map<number, { state: string; startTime: string }>();
    for (const pid of pids) {
      const startTime = mockReadProcessStartTime(pid);
      if (startTime === null) continue;
      observations.set(pid, {
        state: mockIsProcessZombie(pid) ? 'ZN' : 'Ss',
        startTime,
      });
    }
    return observations;
  },
}));

import { classifyOwnerLiveness, classifyOwnerLivenessFromObservation } from './owner-identity.ts';

const OWNER_PID = 4242;

beforeEach(() => {
  mockIsProcessAlive.mockReset().mockReturnValue(true);
  mockIsProcessZombie.mockReset().mockReturnValue(false);
  mockReadProcessStartTime.mockReset().mockReturnValue('start-a');
});

test('classifies a zombie owner as owner-process-dead despite a matching start time', () => {
  mockIsProcessZombie.mockReturnValue(true);
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: 'start-a' } }),
    'owner-process-dead',
  );
});

test('a failed start-time read is not proof of death for an alive pid', () => {
  mockReadProcessStartTime.mockReturnValue(null);
  assert.equal(classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: 'start-a' } }), 'live');
});

test('a definite start-time mismatch classifies as owner-process-reused', () => {
  mockReadProcessStartTime.mockReturnValue('start-b');
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: 'start-a' } }),
    'owner-process-reused',
  );
});

test.each([
  ['Mon Aug 10 20:00:00 2026', 'linux:11111111-1111-4111-8111-111111111111:12345'],
  ['linux:11111111-1111-4111-8111-111111111111:12345', 'Mon Aug 10 20:00:00 2026'],
])('an owner with an incomparable start-time format retains its resource', (recorded, observed) => {
  mockReadProcessStartTime.mockReturnValue(observed);
  assert.equal(classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: recorded } }), 'live');
});

test('a null-start-time owner stays fail-closed while its pid is alive', () => {
  // No same-clock-domain proof of birth order exists for a null-start owner:
  // a clock step could make a live owner look like it started after the
  // resource was acquired, so an alive pid must never be condemned on age.
  assert.equal(classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: null } }), 'live');
});

test('a missing entry in a completed process snapshot stays fail-closed without another ps read', () => {
  assert.equal(
    classifyOwnerLivenessFromObservation({ owner: { pid: OWNER_PID, startTime: 'start-a' } }, null),
    'live',
  );
  assert.equal(mockIsProcessZombie.mock.calls.length, 0);
  assert.equal(mockReadProcessStartTime.mock.calls.length, 0);
});

test('a pid outside the native range is unknown without a liveness probe', () => {
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: 2_147_483_648, startTime: 'start-a' } }),
    'unknown',
  );
  assert.equal(mockIsProcessAlive.mock.calls.length, 0);
  assert.equal(mockIsProcessZombie.mock.calls.length, 0);
  assert.equal(mockReadProcessStartTime.mock.calls.length, 0);
});

test('the snapshot path probes liveness for the owner pid exactly once', () => {
  // The guards were once duplicated across the snapshot entry and the shared
  // judge, paying two kill(pid, 0) per poll on the very path whose single
  // snapshot exists to stop double probing.
  assert.equal(classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: 'start-a' } }), 'live');
  assert.equal(mockIsProcessAlive.mock.calls.length, 1);
});
