/**
 * Waits at most `graceMs` for optional capture metadata that is read beside the image, such as
 * the display rotation. A read still running at the deadline yields `undefined`; the caller then
 * aborts it and reports the fact as absent.
 *
 * `@agent-device/host-kit/settle-within` is reached only while this wait runs, so the capture-kit
 * façade keeps its dependency-free shape: importing it evaluates the grace policy alone, not the
 * host mechanics it delegates to. Those arrive on the call's first use, before the deadline is
 * armed, and the primitive clears its own timer on every settle path.
 */
export async function resolvedWithinGrace<T>(
  pending: Promise<T>,
  graceMs: number,
): Promise<T | undefined> {
  const { settleWithin } = await import('@agent-device/host-kit/settle-within');
  const outcome = await settleWithin(() => pending, graceMs);
  return outcome.kind === 'settled' ? outcome.value : undefined;
}
