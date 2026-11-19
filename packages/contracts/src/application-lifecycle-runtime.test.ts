import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  availableAppleApplicationToolsForProvider,
  type AppleApplicationTools,
} from './application-lifecycle-runtime.ts';

/** Every member the root port carries; the projection is checked against this full key set. */
const FULL_PORT_MEMBERS: readonly (keyof AppleApplicationTools)[] = [
  'resolveOpenTarget',
  'prewarmRunnerCache',
  'prewarmRunnerSession',
  'notifyRunnerAppRelaunched',
  'stopRunnerSession',
  'hasLiveRunnerSession',
  'releaseSpeculativeRunner',
  'releaseRunnerOnClose',
  'prepareRunner',
  'applyRuntimeHints',
  'clearRuntimeHints',
  'dismissCloseAlerts',
  'detachRunnerSessionsForShutdown',
  'finalizeRunnerSessionsForShutdown',
];

function fullTools(reached: string[]): AppleApplicationTools {
  const fail = (name: string) =>
    (async () => {
      reached.push(name);
    }) as never;
  return Object.fromEntries(
    FULL_PORT_MEMBERS.map((member) => [member, fail(member)]),
  ) as unknown as AppleApplicationTools;
}

describe('availableAppleApplicationToolsForProvider', () => {
  test('the projection publishes exactly the three operations a provider consumes', () => {
    const projected = availableAppleApplicationToolsForProvider(fullTools([]));
    assert.deepEqual(Object.keys(projected).sort(), [
      'applyRuntimeHints',
      'clearRuntimeHints',
      'resolveOpenTarget',
    ]);
    assert.ok(Object.isFrozen(projected));
  });

  test('the runner and shutdown members are gone from the runtime value, not only the type', async () => {
    const reached: string[] = [];
    const projected = availableAppleApplicationToolsForProvider(
      fullTools(reached),
    ) as AppleApplicationTools & Record<string, unknown>;
    // A holder reading through an unchecked reference gets `undefined`: there is no member to call,
    // so no runner-session id, this lease's or another session's, can reach the daemon's registry.
    for (const member of [
      'stopRunnerSession',
      'releaseRunnerOnClose',
      'prepareRunner',
      'prewarmRunnerSession',
      'prewarmRunnerCache',
      'notifyRunnerAppRelaunched',
      'hasLiveRunnerSession',
      'releaseSpeculativeRunner',
      'dismissCloseAlerts',
      'detachRunnerSessionsForShutdown',
      'finalizeRunnerSessionsForShutdown',
    ]) {
      assert.equal(projected[member], undefined, member);
    }
    await projected.applyRuntimeHints?.({ id: 'sim-1' } as never, { values: {} });
    assert.deepEqual(reached, ['applyRuntimeHints']);
  });
});
