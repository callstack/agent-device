import { parentPort } from 'node:worker_threads';
import { normalizeError } from '../kernel/errors.ts';
import { PNG } from './png-codec.ts';
import { decodePng } from './png.ts';
import { computeScreenshotDiffPixels } from './screenshot-diff-pixels.ts';
import {
  toBuffer,
  type PngWorkerJobResult,
  type PngWorkerRequest,
  type PngWorkerResponse,
} from './png-worker-contract.ts';

/**
 * Worker thread entry that runs CPU-heavy PNG decode/encode and screenshot
 * pixel-diff jobs off the daemon event loop. Spawned lazily by
 * `png-worker-client.ts`; published as the `internal/png-worker` build entry.
 */

function runJob(request: PngWorkerRequest): PngWorkerJobResult {
  switch (request.kind) {
    case 'decode': {
      const png = decodePng(toBuffer(request.png), request.label);
      return { kind: 'decode', width: png.width, height: png.height, data: png.data };
    }
    case 'encode': {
      const png = new PNG({
        width: request.width,
        height: request.height,
        data: toBuffer(request.data),
      });
      return { kind: 'encode', png: PNG.sync.write(png) };
    }
    case 'diff-pixels': {
      return { kind: 'diff-pixels', ...computeScreenshotDiffPixels(request) };
    }
  }
}

/**
 * True when the view fully owns a real ArrayBuffer. Views over a slice of a
 * larger buffer (e.g. Node's shared pool for small Buffers) do not qualify:
 * transferring their backing store would detach unrelated Buffers.
 */
function ownsEntireArrayBuffer(view: Uint8Array): view is Uint8Array<ArrayBuffer> {
  return (
    view.buffer instanceof ArrayBuffer &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength
  );
}

/**
 * Transfers result buffers instead of structured-cloning them, but only when a
 * view fully owns its ArrayBuffer. Exported for direct unit coverage; the
 * worker itself is the only runtime caller.
 */
export function resultTransferList(result: PngWorkerJobResult): ArrayBuffer[] {
  return resultBufferViews(result)
    .filter(ownsEntireArrayBuffer)
    .map((view) => view.buffer);
}

function resultBufferViews(result: PngWorkerJobResult): Uint8Array[] {
  switch (result.kind) {
    case 'decode':
      return [result.data];
    case 'encode':
      return [result.png];
    case 'diff-pixels':
      return [result.diffData, result.diffMask];
  }
}

const port = parentPort;
if (port) {
  port.on('message', (request: PngWorkerRequest) => {
    let response: PngWorkerResponse;
    try {
      response = { id: request.id, ok: true, result: runJob(request) };
    } catch (error) {
      response = { id: request.id, ok: false, error: normalizeError(error) };
    }
    port.postMessage(response, response.ok ? resultTransferList(response.result) : []);
  });
}
