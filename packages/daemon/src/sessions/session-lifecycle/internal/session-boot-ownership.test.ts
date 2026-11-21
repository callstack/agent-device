import { describe, expect, test } from 'vitest';
import { resolveSessionBootOwnership } from './session-boot-ownership.ts';

// #4791: boot ownership is decided from the platform's own boot report, not from what an inventory
// snapshot said before the boot could happen. These pin the decision at the owner of the type; the
// routed close behavior is pinned in the session-lifecycle __tests__ lane.
describe('resolveSessionBootOwnership', () => {
  test('a boot the boot step reports performing owns the stop on its own', () => {
    expect(
      resolveSessionBootOwnership({
        inferredFromSnapshot: false,
        bootPerformance: { performed: true },
      }),
    ).toBe('proved');
  });

  test('the snapshot inference still owns the boot for an owner that reports nothing', () => {
    // Android boots through the daemon's own emulator launch outside its preparation, so it answers
    // nothing and the inference stays in charge there.
    expect(
      resolveSessionBootOwnership({ inferredFromSnapshot: true, bootPerformance: undefined }),
    ).toBe('inferred');
  });

  test('a boot the boot step disproves refuses the snapshot inference and says so', () => {
    expect(
      resolveSessionBootOwnership({
        inferredFromSnapshot: true,
        bootPerformance: { performed: false, reason: 'already-booted' },
      }),
    ).toBe('disproved');
  });

  test('nothing is owed when neither the snapshot nor the boot step claims a boot', () => {
    expect(
      resolveSessionBootOwnership({
        inferredFromSnapshot: false,
        bootPerformance: { performed: false, reason: 'no-boot-attempt' },
      }),
    ).toBe('none');
  });

  test('a disproved boot nobody inferred is no claim either', () => {
    expect(
      resolveSessionBootOwnership({
        inferredFromSnapshot: false,
        bootPerformance: { performed: false, reason: 'already-booted' },
      }),
    ).toBe('none');
  });
});
