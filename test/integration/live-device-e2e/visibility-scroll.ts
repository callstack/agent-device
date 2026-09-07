import assert from 'node:assert/strict';

import type { CliJsonResult } from '../cli-json.ts';
import type { LiveDeviceContext } from './runtime.ts';

type RunStep<Context> = (
  context: Context,
  step: string,
  args: string[],
  options?: { allowFailure?: boolean },
) => Promise<CliJsonResult>;

const SCROLL_SEARCH_ATTEMPTS = 4;
// A stalled capture says nothing about where the element is, so it must not consume the scroll
// budget outright; a couple of retries absorb a slow runner without masking a real absence.
const SCROLL_SEARCH_STALL_RETRIES = 2;
// One finger path per attempt. `scroll` is a gesture, not an offset — app scroll physics decide
// where the content lands — so the search re-probes rather than trusting a single amount.
const SCROLL_SEARCH_AMOUNT = '0.75';

/**
 * Searches by semantic visibility rather than selector existence. An offscreen node can exist in
 * the accessibility tree, so a successful `wait <selector>` is not sufficient evidence to skip
 * scrolling. The callbacks keep this live-device policy deterministic and unit-testable without a
 * device.
 */
export async function searchForVisibleElement(
  selector: string,
  probeVisibility: (attempt: number) => Promise<CliJsonResult>,
  scrollAfterAttempt: (attempt: number) => Promise<void>,
  probeForEvidence?: () => Promise<CliJsonResult>,
): Promise<void> {
  let stallRetriesLeft = SCROLL_SEARCH_STALL_RETRIES;
  let lastFailure: CliJsonResult | undefined;

  for (let attempt = 1; attempt <= SCROLL_SEARCH_ATTEMPTS;) {
    const probe = await probeVisibility(attempt);
    if (probe.status === 0) return;
    lastFailure = probe;

    // The snapshot never came back, so the surface was never read. Scrolling here would move the
    // surface for a reason unrelated to visibility and spend an attempt on no evidence.
    if (probe.json?.error?.details?.captureStalled === true && stallRetriesLeft > 0) {
      stallRetriesLeft -= 1;
      continue;
    }

    attempt += 1;
    if (attempt <= SCROLL_SEARCH_ATTEMPTS) {
      await scrollAfterAttempt(attempt - 1);
    }
  }
  // The probes above run with `allowFailure`, so none of them reached the harness's failed-step
  // evidence capture. Spend one more as a real step: it fails the same way and writes the
  // screenshot, snapshot and device facts that say what was on screen instead.
  await probeForEvidence?.();
  assert.fail(
    `${selector} did not become visible after scrolling\nlast visibility probe: ${JSON.stringify(lastFailure?.json ?? null)}`,
  );
}

/**
 * Binds {@link searchForVisibleElement} to a platform's `runStep`, so every live scenario reveals
 * a canary the same way: probe visibility, scroll one finger path, probe again.
 */
export function createVisibilityScroll<
  BehaviorId extends string,
  Context extends LiveDeviceContext<BehaviorId>,
>(runStep: RunStep<Context>) {
  async function scrollUntilVisible(context: Context, selector: string): Promise<void> {
    await searchForVisibleElement(
      selector,
      (attempt) =>
        runStep(
          context,
          `check ${selector} visibility after scroll (attempt ${attempt})`,
          ['is', 'visible', selector],
          { allowFailure: true },
        ),
      (attempt) =>
        runStep(context, `scroll toward ${selector} after attempt ${attempt}`, [
          'scroll',
          'down',
          SCROLL_SEARCH_AMOUNT,
        ]).then(() => undefined),
      () =>
        runStep(context, `probe ${selector} after exhausting the scroll budget`, [
          'is',
          'visible',
          selector,
        ]),
    );
  }

  return { scrollUntilVisible };
}
