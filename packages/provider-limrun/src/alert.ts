import type {
  TreeAlertDriver,
  TreeAlertObservation,
  TreeAlertPress,
  TreeAlertResult,
} from '@agent-device/platform-android/mechanics';
import { runTreeAlertAction } from '@agent-device/platform-android/mechanics';
import type { InstanceClient as LimrunIosClient } from '@limrun/api/ios-client';
import {
  chooseLimrunAlertButton,
  type LimrunAlertCandidate,
  type LimrunAlertInfo,
  readLimrunAlertCapture,
} from './alert-detection.ts';

/**
 * The four alert legs on a Limrun iOS direct session (issue #3349). There is no XCUITest runner
 * to ask, so this backend supplies the shared tree-alert driver (`platform-android`'s
 * `runTreeAlertAction`, the one poll/confirm/same-alert/response owner every tree-based backend
 * rides) with its own observation and press seams only: observation through the session's own
 * element-tree capture and its host-root reader, action through the same point-touch seam every
 * other touch operation rides.
 */

/** The client methods the legs use; declared here so the legs are testable without a live instance. */
export type LimrunIosAlertClient = Readonly<{
  elementTree: LimrunIosClient['elementTree'];
  tap: LimrunIosClient['tap'];
}>;

export type LimrunIosAlertResult = TreeAlertResult<LimrunAlertInfo, 'ios'>;

export type LimrunIosAlertAction = 'get' | 'wait' | 'accept' | 'dismiss';

export async function handleLimrunIosAlert(
  client: LimrunIosAlertClient,
  action: LimrunIosAlertAction,
  options?: Readonly<{ timeoutMs?: number }>,
): Promise<LimrunIosAlertResult> {
  const driver: TreeAlertDriver<
    Awaited<ReturnType<LimrunIosClient['elementTree']>>,
    LimrunAlertInfo,
    LimrunAlertCandidate['buttons'][number],
    LimrunAlertCandidate,
    'ios'
  > = {
    platform: 'ios',
    timeoutMs: options?.timeoutMs,
    capture: () => client.elementTree(),
    findCandidate: (tree): TreeAlertObservation<LimrunAlertCandidate> =>
      readLimrunAlertCapture(tree as Parameters<typeof readLimrunAlertCapture>[0]),
    // Stricter than Android's by design: only the button whose own label states the asked-for
    // choice may be pressed; there is no platform fallback key to invent on iOS. The shared
    // driver names the refusal when this returns null.
    choose: (candidate, act): TreeAlertPress<LimrunAlertCandidate['buttons'][number]> | null => {
      const button = chooseLimrunAlertButton(candidate.buttons, act);
      return button ? { kind: 'press', button } : null;
    },
    press: async (choice) => {
      // `dismiss` never authorizes tracking: the chooser above presses only the one button the
      // action's own label names, and a tap that falls back to a guess is never dispatched.
      if (choice.kind === 'press') await client.tap(choice.button.x, choice.button.y);
    },
  };
  return await runTreeAlertAction(action, driver);
}
