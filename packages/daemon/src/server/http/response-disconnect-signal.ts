import type http from 'node:http';
import { createRequestCanceledError } from '@agent-device/kernel/errors';

/** Cancels work when the HTTP client abandons an unfinished response. */
export function responseDisconnectSignal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): AbortSignal {
  const controller = new AbortController();
  function cancelIfDisconnected(): void {
    // A finished response also emits close.
    if (!res.writableFinished) controller.abort(createRequestCanceledError());
    req.off('aborted', cancelIfDisconnected);
    res.off('close', cancelIfDisconnected);
  }
  req.once('aborted', cancelIfDisconnected);
  res.once('close', cancelIfDisconnected);
  if (req.aborted || res.destroyed) cancelIfDisconnected();
  return controller.signal;
}
