import type { IncomingHttpHeaders } from 'node:http';

export type CloudWebDriverHttpCall = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body?: unknown;
  /** The caller's cancellation, so a fixture can prove it reached the wire. */
  signal?: AbortSignal;
};

export type CloudWebDriverTestResponse = {
  body: unknown;
  status?: number;
  /**
   * A driver that never answers. The request stays in flight until the caller's own
   * cancellation reaches the transport, then rejects with that caller's reason.
   * Models the #2509 shape — a server-side command the client gave up on — which a
   * fixture that can only answer fast or answer wrong cannot express.
   */
  neverAnswers?: boolean;
};

/**
 * In-memory Fetch transport for Cloud WebDriver integration scenarios.
 *
 * The production client still uses Fetch; this fixture observes the exact
 * request URL, headers and body, then supplies a real Response. Avoiding a
 * loopback listener keeps the suite hermetic in sandboxes that prohibit
 * binding ports without reducing request/response transport coverage.
 */
export abstract class CloudWebDriverTestServer {
  readonly calls: CloudWebDriverHttpCall[] = [];
  // fallow-ignore-next-line unused-class-member
  readonly url = 'http://cloud-webdriver.test';

  protected abstract respond(call: CloudWebDriverHttpCall): CloudWebDriverTestResponse;

  // fallow-ignore-next-line unused-class-member
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const call: CloudWebDriverHttpCall = {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers.entries()),
      ...(init?.signal === null || init?.signal === undefined
        ? {}
        : { signal: init.signal as AbortSignal }),
      ...(await requestBody(request)),
    };
    this.calls.push(call);
    const response = this.respond(call);
    if (response.neverAnswers === true) {
      return await neverAnsweredResponse(call.signal);
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

export type StartedCloudWebDriverTestServer<T extends CloudWebDriverTestServer> = T & {
  close(): Promise<void>;
};

export async function startCloudWebDriverTestServer<T extends CloudWebDriverTestServer>(
  testServer: T,
): Promise<StartedCloudWebDriverTestServer<T>> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = testServer.fetch;
  return Object.assign(testServer, {
    close: async () => {
      if (globalThis.fetch === testServer.fetch) globalThis.fetch = previousFetch;
    },
  });
}

export function cloudWebDriverTestJson(body: unknown, status = 200): CloudWebDriverTestResponse {
  return { body, status };
}

/** A driver that never answers: only the caller's cancellation ends it. */
async function neverAnsweredResponse(signal: AbortSignal | undefined): Promise<Response> {
  return await new Promise<Response>((_resolve, reject) => {
    if (!signal) {
      reject(new Error('A never-answered request needs the caller cancellation to end it.'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

async function requestBody(request: Request): Promise<{ body?: unknown }> {
  if (!request.body) return {};
  const buffer = Buffer.from(await request.arrayBuffer());
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    return { body: { multipartBytes: buffer.length } };
  }
  const text = buffer.toString('utf8');
  return text ? { body: JSON.parse(text) as unknown } : {};
}
