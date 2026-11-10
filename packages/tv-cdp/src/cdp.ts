import { AppError } from '@agent-device/kernel/errors';

import { createReplyWaiters } from './replies.ts';

const REQUEST_TIMEOUT_MS = 20_000;
const CDP_HINT =
  'Close Chrome DevTools and other inspector clients attached to the app, then open it again.';

export type CdpTarget = Readonly<{
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}>;

export type CdpSession = Readonly<{
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T>(expression: string): Promise<T>;
  on(listener: (method: string, params: Record<string, unknown>) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}>;

type CdpMessage = {
  id?: number;
  method?: unknown;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string; code: number };
};

function parseCdpMessage(data: unknown): CdpMessage | undefined {
  try {
    const message: unknown = JSON.parse(String(data));
    return isRecord(message) ? (message as CdpMessage) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records a debug event in the request diagnostics. The emitter loads on demand because these
 * events are rare and this module sits in the package's eager import closure.
 */
function emitCdpDiagnostic(phase: string, data: Record<string, unknown>): void {
  void import('@agent-device/host-kit/diagnostics')
    .then(({ emitDiagnostic }) => emitDiagnostic({ level: 'debug', phase, data }))
    .catch(() => undefined);
}

/** Never throws: a listener can throw a value that `String()` cannot convert. */
function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'non-error thrown value';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://localhost:${port}/json`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new AppError(
      'COMMAND_FAILED',
      `The inspector at localhost:${port} answered ${response.status}`,
    );
  }
  return ((await response.json()) as CdpTarget[]).filter((target) => target.webSocketDebuggerUrl);
}

export async function connectCdp(target: CdpTarget): Promise<CdpSession> {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const fail = (message: string) => {
      clearTimeout(timer);
      reject(new AppError('COMMAND_FAILED', message, { hint: CDP_HINT }));
    };
    const timer = setTimeout(() => {
      socket.close();
      fail(`The TV page at ${target.url} did not open within ${REQUEST_TIMEOUT_MS}ms`);
    }, REQUEST_TIMEOUT_MS);
    socket.onopen = (event) => {
      clearTimeout(timer);
      resolve(event);
    };
    socket.onerror = () => fail(`Could not open the TV page at ${target.url}`);
  });

  let nextId = 0;
  const replies = createReplyWaiters<CdpMessage>();
  const listeners: ((method: string, params: Record<string, unknown>) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  // A throw from a WebSocket listener is an uncaught exception that ends the process, so a frame
  // this session cannot read is dropped with a diagnostic and the session keeps serving requests.
  socket.onmessage = (event) => {
    const message = parseCdpMessage(event.data);
    if (message === undefined) {
      emitCdpDiagnostic('tv_cdp_frame_unreadable', { target: target.url });
      return;
    }
    if (message.method !== undefined) {
      // A frame that names a method is an event; one whose method is not a name is unreadable,
      // and never a reply, even when it carries an id.
      if (typeof message.method !== 'string') return;
      const params = isRecord(message.params) ? message.params : {};
      for (const listener of listeners) {
        try {
          listener(message.method, params);
        } catch (error) {
          emitCdpDiagnostic('tv_cdp_event_listener_failed', {
            method: message.method,
            error: describeThrown(error),
          });
        }
      }
    } else if (message.id !== undefined) {
      replies.deliver(String(message.id), message);
    }
  };
  socket.onclose = () => {
    replies.failAll(
      new AppError('COMMAND_FAILED', 'The TV page connection closed', { hint: CDP_HINT }),
    );
    for (const listener of closeListeners) listener();
  };

  const send = <T>(method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = replies.wait<T>(
      String(id),
      REQUEST_TIMEOUT_MS,
      () =>
        new AppError('COMMAND_FAILED', `${method} got no answer within ${REQUEST_TIMEOUT_MS}ms`, {
          hint: CDP_HINT,
        }),
      (message) =>
        message.error
          ? {
              error: new AppError('COMMAND_FAILED', `${method} failed: ${message.error.message}`, {
                cdpErrorCode: message.error.code,
              }),
            }
          : { value: message.result as T },
    );
    socket.send(JSON.stringify({ id, method, params }));
    return reply;
  };

  return {
    send,
    async evaluate<T>(expression: string) {
      const { result, exceptionDetails } = await send<{
        result: { value?: T };
        exceptionDetails?: { exception?: { description?: string }; text: string };
      }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) {
        throw new AppError(
          'COMMAND_FAILED',
          `Page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
        );
      }
      return result.value as T;
    },
    on: (listener) => listeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    close: () => socket.close(),
  };
}
