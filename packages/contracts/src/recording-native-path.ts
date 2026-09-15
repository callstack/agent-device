/**
 * What may happen to the recorder's native artifact path — the file the recorder itself writes
 * (the `simctl` output, the device-side chunks, the media-library item, the browser's WebM) once a
 * recording's export is committed (ADR 0024 2.3). This is the second of the two facts a stop
 * answers, and it stays independent of the recorder observation: a recorder that never confirmed
 * leaves its path `pending` even when the export is playable, and a `lost` identity says nothing
 * about who writes there now, so it never permits a deletion either.
 *
 * - `pending`: the backend has not proven the writer gone, so nothing may remove the path.
 * - `retirable`: the writer is proven gone; a fenced retirement is still owed.
 * - `retired`: retirement succeeded or the backend verified the artifact is absent.
 *
 * The bullets define the vocabulary; they are not a claim that anything emits each state. Today's
 * producers answer `retirable` for an Apple runner artifact left on the device and `retired` for an
 * Android recording whose chunks the device no longer shows or a HarmonyOS recording whose removals
 * were verified. A backend whose recorder writes the served export itself omits the field. `pending`
 * is declared ahead of the step that reports a recorder nobody proved gone, and no stop emits it yet.
 */
export const NATIVE_PATH_DISPOSITION_VALUES = ['pending', 'retirable', 'retired'] as const;

export type NativePathDisposition = (typeof NATIVE_PATH_DISPOSITION_VALUES)[number];

export function isNativePathDisposition(value: unknown): value is NativePathDisposition {
  return NATIVE_PATH_DISPOSITION_VALUES.some((disposition) => disposition === value);
}
