import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { classifyOwnerLiveness } from '../owner-identity.ts';
import { readProcessStartTime } from '../host-process.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

test('classifies dead and PID-reused owners as owner-process-dead', () => {
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: 999_999_999, startTime: 'old-start' } }),
    'owner-process-dead',
  );
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: process.pid, startTime: 'not-this-process' } }),
    'owner-process-dead',
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
