import { describe, expect, test } from 'vitest';
import { resolveSessionBootOwnership } from '../device-boot.ts';

// #4791: boot ownership is decided from the platform's own boot report, not from what an inventory
// snapshot said before the boot could happen. These pin the decision at the owner of the type; the
// routed close behavior is pinned in the daemon's session-lifecycle lane.
describe('resolveSessionBootOwnership', () => {
  test('a boot the boot step reports performing owns the stop on its own', () => {
    expect(
      resolveSessionBootOwnership({
        inferredFromSnapshot: false,
        bootPerformance: { performed: true },
      }),
    ).toEqual({ ownsBoot: true, bootOwnerUnverified: false });
  });

  test('the snapshot inference still owns the boot for an owner that reports nothing', () => {
    // Android boots through the daemon's own emulator launch outside its preparation, so it answers
    // nothing and the inference stays in charge there.
    expect(
      resolveSessionBootOwnership({ inferredFromSnapshot: true, bootPerformance: undefined }),
    ).toEqual({ ownsBoot: true, bootOwnerUnverified: false });
  });

  test('a boot the boot step disproves refuses the snapshot inference and says so', () => {
    expect(
      resolveSessionBootOwnership({
        inferredFromSnapshot: true,
        bootPerformance: { performed: false, reason: 'already-booted' },
      }),
    ).toEqual({ ownsBoot: false, bootOwnerUnverified: true });
  });

  test('nothing is owed when neither the snapshot nor the boot step claims a boot', () => {
    expect(
      resolveSessionBootOwnership({
        inferredFromSnapshot: false,
        bootPerformance: { performed: false, reason: 'no-boot-attempt' },
      }),
    ).toEqual({ ownsBoot: false, bootOwnerUnverified: false });
  });
});
