import assert from 'node:assert/strict';
import fs from 'node:fs';

import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  classifyOwnerLiveness,
  ownerIdentityDiffers,
  ownerIdentityMatches,
  type OwnerIdentity,
} from './owner-identity.ts';
import {
  readProcessStartTime,
  readHostProcessIdentityObservations,
  readHostProcessIdentityObservationsAsync,
  readProcessIdentityFacts,
} from './host-process.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

test('distinguishes dead and PID-reused owners', () => {
  assert.equal(
    classifyOwnerLiveness({ owner: { pid: 999_999_999, startTime: 'old-start' } }),
    'owner-process-dead',
  );
  assert.equal(
    classifyOwnerLiveness({
      owner: {
        pid: process.pid,
        startTime: readProcessStartTime(process.pid)?.startsWith('linux:')
          ? 'linux:other-boot:1'
          : 'not-this-process',
      },
    }),
    'owner-process-reused',
  );
});

test('distinguishes a gone state directory from permission and transient I/O failures', () => {
  const startTime = readProcessStartTime(process.pid);
  const missing = path.join(
    mkdtempForTestSync('agent-device-missing-owner'),
    `agent-device-missing-owner-${Date.now()}`,
  );
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
  assert.equal(
    differs(
      { pid: 1, startTime: 'Mon Aug 10 20:00:00 2026' },
      { pid: 1, startTime: 'linux:boot:1' },
    ),
    false,
  );
  assert.equal(
    differs({ pid: 1, startTime: 'linux:boot:1' }, { pid: 1, startTime: 'linux:boot:2' }),
    true,
  );
  // An unreadable start time on either side leaves equal pids unproven, never
  // different — the inverse mistake would hand a held resource to a second owner.
  assert.equal(differs({ pid: 1, startTime: null }, { pid: 1, startTime: 'b' }), false);
  assert.equal(differs({ pid: 1, startTime: 'a' }, { pid: 1, startTime: null }), false);
  assert.equal(
    ownerIdentityMatches({ pid: 1, startTime: null }, { pid: 1, startTime: 'b' }),
    false,
  );
});

test.skipIf(process.platform !== 'linux')(
  'real Linux process reads share the kernel lifetime token',
  async () => {
    const token = readProcessStartTime(process.pid);
    assert.match(token ?? '', /^linux:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/);
    assert.equal(
      readHostProcessIdentityObservations([process.pid]).get(process.pid)?.startTime,
      token,
    );
    assert.equal(
      (await readHostProcessIdentityObservationsAsync([process.pid])).get(process.pid)?.startTime,
      token,
    );
    assert.equal((await readProcessIdentityFacts(process.pid)).startTime, token);
  },
);
