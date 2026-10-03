import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestProgressEvent, RequestProgressSink } from '@agent-device/contracts/progress';

// The event vocabulary is a wire contract shared with the CLI reporter path, so it lives in
// `@agent-device/contracts/progress`. This module owns only the request-global plumbing that
// carries it: the per-request sink and its AsyncLocalStorage binding.

const requestProgress = new AsyncLocalStorage<RequestProgressSink | undefined>();

export async function withRequestProgressSink<T>(
  sink: RequestProgressSink | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return await requestProgress.run(sink, run);
}

export function emitRequestProgress(event: RequestProgressEvent): void {
  requestProgress.getStore()?.(event);
}
