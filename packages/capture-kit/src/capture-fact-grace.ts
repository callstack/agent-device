/**
 * Waits at most `graceMs` for optional capture metadata that is read beside the image, such as
 * the display rotation. A read still running at the deadline yields `undefined`; the caller then
 * aborts it and reports the fact as absent.
 */
export async function resolvedWithinGrace<T>(
  pending: Promise<T>,
  graceMs: number,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
