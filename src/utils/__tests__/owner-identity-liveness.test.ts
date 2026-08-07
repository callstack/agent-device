import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const {
  mockIsProcessAlive,
  mockIsProcessZombie,
  mockReadProcessStartTime,
  mockReadProcessStartedAtMs,
} = vi.hoisted(() => ({
  mockIsProcessAlive: vi.fn(),
  mockIsProcessZombie: vi.fn(),
  mockReadProcessStartTime: vi.fn(),
  mockReadProcessStartedAtMs: vi.fn(),
}));

vi.mock('../host-process.ts', () => ({
  isProcessAlive: mockIsProcessAlive,
  isProcessZombie: mockIsProcessZombie,
  readProcessStartTime: mockReadProcessStartTime,
  readProcessStartedAtMs: mockReadProcessStartedAtMs,
}));

import { classifyOwnerLiveness } from '../owner-identity.ts';

const OWNER_PID = 4242;

beforeEach(() => {
  mockIsProcessAlive.mockReset().mockReturnValue(true);
  mockIsProcessZombie.mockReset().mockReturnValue(false);
  mockReadProcessStartTime.mockReset().mockReturnValue('start-a');
  mockReadProcessStartedAtMs.mockReset().mockReturnValue(null);
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

test('null recorded start time stays live without an acquisition bound', () => {
  mockReadProcessStartedAtMs.mockReturnValue(Date.now());
  assert.equal(classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: null } }), 'live');
});

test('null recorded start time dies when the pid started after acquisition', () => {
  const acquiredAtMs = 1_000_000;
  mockReadProcessStartedAtMs.mockReturnValue(acquiredAtMs + 120_000);
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: null }, acquiredAtMs }),
    'owner-process-dead',
  );
});

test('null recorded start time stays live when the pid started before acquisition or within slack', () => {
  const acquiredAtMs = 1_000_000;
  mockReadProcessStartedAtMs.mockReturnValue(acquiredAtMs - 5_000);
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: null }, acquiredAtMs }),
    'live',
  );
  mockReadProcessStartedAtMs.mockReturnValue(acquiredAtMs + 5_000);
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: null }, acquiredAtMs }),
    'live',
  );
  mockReadProcessStartedAtMs.mockReturnValue(null);
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: OWNER_PID, startTime: null }, acquiredAtMs }),
    'live',
  );
});
