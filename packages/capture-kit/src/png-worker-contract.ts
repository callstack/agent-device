import type { NormalizedError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import type {
  ScreenshotDiffPixelsJob,
  ScreenshotDiffPixelsResult,
} from './screenshot-diff-pixels.ts';
import type { PngRgbDifferenceResult } from './png-rgb-difference.ts';

/**
 * Message contract between the daemon-side PNG worker client
 * (`png-worker-client.ts`) and the worker thread entry (`png-worker.ts`).
 * One message = one decode, encode, crop, diff, or transcode job. Binary payloads cross the
 * thread boundary via structured clone (or transfer), so `Buffer` fields
 * arrive as plain `Uint8Array` views on the receiving side.
 */

export type PngWorkerJob =
  | { kind: 'decode'; png: Uint8Array; label: string }
  // A screenshot in whatever container it arrived in; answers decoded pixels, not PNG bytes.
  | { kind: 'decode-image'; image: Uint8Array; label: string }
  | { kind: 'encode'; width: number; height: number; data: Uint8Array }
  | { kind: 'crop'; png: Uint8Array; label: string; box: Rect }
  | { kind: 'rgb-difference'; firstPng: Uint8Array; secondPng: Uint8Array; label: string }
  | ({ kind: 'diff-pixels' } & ScreenshotDiffPixelsJob)
  // A provider screenshot in whatever container it arrived in; answers PNG bytes.
  | { kind: 'jpeg-to-png'; image: Uint8Array; label: string };

export type PngWorkerJobResult =
  | { kind: 'decode'; width: number; height: number; data: Uint8Array }
  | { kind: 'decode-image'; width: number; height: number; data: Uint8Array }
  | { kind: 'encode'; png: Uint8Array }
  // A crop answers `null` when the box already covers the image, so the caller keeps the file.
  | { kind: 'crop'; png: Uint8Array | null }
  | ({ kind: 'rgb-difference' } & PngRgbDifferenceResult)
  | ({ kind: 'diff-pixels' } & ScreenshotDiffPixelsResult)
  | { kind: 'jpeg-to-png'; png: Uint8Array };

export type PngWorkerJobKind = PngWorkerJob['kind'];

export type PngWorkerJobFor<Kind extends PngWorkerJobKind> = Extract<PngWorkerJob, { kind: Kind }>;

export type PngWorkerJobResultFor<Kind extends PngWorkerJobKind> = Extract<
  PngWorkerJobResult,
  { kind: Kind }
>;

export type PngWorkerRequest = PngWorkerJob & { id: number };

export type PngWorkerResponse =
  | { id: number; ok: true; result: PngWorkerJobResult }
  | { id: number; ok: false; error: NormalizedError };

/** Rewraps a structured-clone-delivered view as a Buffer without copying. */
export function toBuffer(view: Uint8Array): Buffer {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}
