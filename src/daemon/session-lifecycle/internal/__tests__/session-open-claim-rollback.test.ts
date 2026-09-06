import { beforeEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { rollbackNewSessionClaim } from '../session-open-claim-rollback.ts';
import { makeSessionStore } from './session-open-runtime.fixtures.ts';
import { abandonDeviceClaim, clearDeviceClaim } from '../../../device-claims.ts';

vi.mock('../../../device-claims.ts', () => ({
  abandonDeviceClaim: vi.fn(async () => 'abandoned'),
  clearDeviceClaim: vi.fn(async () => 'deleted'),
}));

beforeEach(() => vi.clearAllMocks());

test.each([
  [new AppError('COMMAND_FAILED', 'cleanup failed', { reason: 'ios_boot_cleanup_failed' }), true],
  [new AppError('COMMAND_FAILED', 'cleanup failed'), false],
  [undefined, false],
] as const)(
  'claim rollback classifies preparation cleanup by typed reason %#',
  async (error, retain) => {
    const ownership = {
      deviceKey: 'apple:ios:sim-1',
      ownerToken: 'test-owner',
      ownerPid: process.pid,
      ownerStartTime: null,
    };
    await rollbackNewSessionClaim({
      ownership,
      effects: { mayHaveStarted: false },
      sessionName: 'cold-start',
      sessionStore: makeSessionStore(),
      error,
    });
    expect(abandonDeviceClaim).toHaveBeenCalledTimes(retain ? 1 : 0);
    expect(clearDeviceClaim).toHaveBeenCalledTimes(retain ? 0 : 1);
  },
);
