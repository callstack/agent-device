import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  classifyOwnerLiveness,
  ownerIdentityDiffers,
  ownerIdentityMatches,
  type OwnerIdentity,
} from '../owner-identity.ts';
import { readProcessStartTime } from '../host-process.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

test('distinguishes dead and PID-reused owners', () => {
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: 999_999_999, startTime: 'old-start' } }),
    'owner-process-dead',
  );
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: process.pid, startTime: 'not-this-process' } }),
    'owner-process-reused',
  );
});

test('distinguishes a gone state directory from permission and transient I/O failures', () => {
  const startTime = readProcessStartTime(process.pid);
  const missing = path.join(os.tmpdir(), `agent-device-missing-owner-${Date.now()}`);
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: process.pid, startTime }, stateDir: missing }),
    'owner-state-dir-gone',
  );

  vi.spyOn(fs, 'statSync').mockImplementation(() => {
    const error = new Error('permission denied') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  });
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: process.pid, startTime }, stateDir: '/protected' }),
    'unknown',
  );
});

test('proves two owners differ only when the evidence is there', () => {
  const differs = (left: OwnerIdentity, right: OwnerIdentity) => ownerIdentityDiffers(left, right);
  assert.equal(differs({ pid: 1, startTime: 'a' }, { pid: 2, startTime: 'a' }), true);
  assert.equal(differs({ pid: 1, startTime: 'a' }, { pid: 1, startTime: 'b' }), true);
  assert.equal(differs({ pid: 1, startTime: 'a' }, { pid: 1, startTime: 'a' }), false);
  // An unreadable start time on either side leaves equal pids unproven, never
  // different — the inverse mistake would hand a held resource to a second owner.
  assert.equal(differs({ pid: 1, startTime: null }, { pid: 1, startTime: 'b' }), false);
  assert.equal(differs({ pid: 1, startTime: 'a' }, { pid: 1, startTime: null }), false);
  assert.equal(
    ownerIdentityMatches({ pid: 1, startTime: null }, { pid: 1, startTime: 'b' }),
    false,
  );
});
