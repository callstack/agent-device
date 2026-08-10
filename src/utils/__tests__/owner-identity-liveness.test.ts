import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockIsProcessAlive, mockIsProcessZombie, mockReadProcessStartTime } = vi.hoisted(() => ({
  mockIsProcessAlive: vi.fn(),
  mockIsProcessZombie: vi.fn(),
  mockReadProcessStartTime: vi.fn(),
}));

vi.mock('../host-process.ts', () => ({
  isProcessAlive: mockIsProcessAlive,
  isProcessZombie: mockIsProcessZombie,
  readProcessStartTime: mockReadProcessStartTime,
}));

import { classifyOwnerLiveness, classifyOwnerLivenessFromObservation } from '../owner-identity.ts';

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

test('a definite start-time mismatch classifies as owner-process-dead', () => {
  mockReadProcessStartTime.mockReturnValue('start-b');
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: 'start-a' } }),
    'owner-process-dead',
  );
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
