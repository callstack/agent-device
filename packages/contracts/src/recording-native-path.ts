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
 */
export const NATIVE_PATH_DISPOSITION_VALUES = ['pending', 'retirable', 'retired'] as const;

export type NativePathDisposition = (typeof NATIVE_PATH_DISPOSITION_VALUES)[number];

export function isNativePathDisposition(value: unknown): value is NativePathDisposition {
  return NATIVE_PATH_DISPOSITION_VALUES.some((disposition) => disposition === value);
}
