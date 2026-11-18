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
  // A proved reuse needs a recorded start time in the same verified format as the live read but
  // with a different value: the `linux:` token on Linux, the CIM stamp on Windows, the pinned
  // C-form `lstart` on macOS.
  const liveStartTime = readProcessStartTime(process.pid);
  const staleStartTime = liveStartTime?.startsWith('linux:')
    ? 'linux:other-boot:1'
    : liveStartTime !== null && /^\d{21}$/.test(liveStartTime)
      ? '00000000000000000000'
      : 'Thu Jan  1 00:00:00 1970';
  assert.equal(
    classifyOwnerLiveness({
      owner: {
        pid: process.pid,
        startTime: staleStartTime,
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
  // Two records in the same verified C-locale format with different values prove a reuse.
  assert.equal(
    differs(
      { pid: 1, startTime: 'Mon Aug 10 20:00:00 2026' },
      { pid: 1, startTime: 'Mon Aug 10 20:00:01 2026' },
    ),
    true,
  );
  // Two legacy-format records are not comparable: neither rendering was read by this build, so
  // a difference between them proves nothing about the lifetime.
  assert.equal(differs({ pid: 1, startTime: 'a' }, { pid: 1, startTime: 'b' }), false);
  assert.equal(differs({ pid: 1, startTime: 'a' }, { pid: 1, startTime: 'a' }), false);
  assert.equal(
    differs(
      { pid: 1, startTime: 'Mon Aug 10 20:00:00 2026' },
      { pid: 1, startTime: 'linux:boot:1' },
    ),
    false,
  );
  // A legacy localized rendering beside a C-form read is unverified, never a proved reuse.
  assert.equal(
    differs(
      { pid: 1, startTime: 'mar. 10 août 20:00:00 2026' },
      { pid: 1, startTime: 'Mon Aug 10 20:00:00 2026' },
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
