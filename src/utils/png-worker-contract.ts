import type { NormalizedError } from '../kernel/errors.ts';
import type {
  ScreenshotDiffPixelsJob,
  ScreenshotDiffPixelsResult,
} from './screenshot-diff-pixels.ts';
import type { PngRgbDifferenceResult } from './png-rgb-difference.ts';

/**
 * Message contract between the daemon-side PNG worker client
 * (`png-worker-client.ts`) and the worker thread entry (`png-worker.ts`).
 * One message = one decode, encode, or diff job. Binary payloads cross the
 * thread boundary via structured clone (or transfer), so `Buffer` fields
 * arrive as plain `Uint8Array` views on the receiving side.
 */

export type PngWorkerJob =
  | { kind: 'decode'; png: Uint8Array; label: string }
  | { kind: 'encode'; width: number; height: number; data: Uint8Array }
  | { kind: 'rgb-difference'; firstPng: Uint8Array; secondPng: Uint8Array; label: string }
  | ({ kind: 'diff-pixels' } & ScreenshotDiffPixelsJob);

export type PngWorkerJobResult =
  | { kind: 'decode'; width: number; height: number; data: Uint8Array }
  | { kind: 'encode'; png: Uint8Array }
  | ({ kind: 'rgb-difference' } & PngRgbDifferenceResult)
  | ({ kind: 'diff-pixels' } & ScreenshotDiffPixelsResult);

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
