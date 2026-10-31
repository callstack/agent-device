import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '@agent-device/kernel/errors';

/** NoMac's REST API for NoMac Simulator phones (https://nomac.app/docs/simulator). */
const NOMAC_DEFAULT_BASE_URL = 'https://nomac.app';
const SESSIONS = '/api/v1/simulator/sessions';
// NoMac or the phone busy for a moment. A 429 was not taken, so any request may be sent again.
const PASSING = new Set([429, 502, 503, 504]);
const JOB = /Next: job_status \{job_id: "([^"]+)"\}/;

export type NomacClientOptions = Readonly<{
  /** Without one, every request refuses with UNAUTHORIZED (the daemon still starts). */
  apiKey?: string;
  baseUrl?: string;
  clientVersion: string;
  fetch?: typeof fetch;
}>;

export type NomacPhone = {
  id: string;
  state: 'queued' | 'provisioning' | 'ready' | 'stopping' | 'stopped' | 'failed';
  failure_code?: string | null;
  label?: string | null;
  device?: string;
  [field: string]: unknown;
};

export type NomacToolContent = { type: string; text?: string; data?: string; mimeType?: string };

export type NomacToolResult = { text: string; content: NomacToolContent[]; isError: boolean };

type RequestOptions = {
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** A request key for one operation: the same key makes a retry the same operation on NoMac. */
const nomacRequestKey = (prefix: string) => `agent-device-${prefix}-${randomUUID()}`;

export class NomacClient {
  private readonly auth: string;
  private readonly base: string;
  private readonly userAgent: string;
  private readonly send: typeof fetch;

  constructor(options: NomacClientOptions) {
    this.auth = options.apiKey ? `Bearer ${options.apiKey}` : '';
    this.base = (options.baseUrl ?? NOMAC_DEFAULT_BASE_URL).replace(/\/+$/, '');
    // agent-device-cli/<version>, as every provider attributes agent-device's traffic.
    this.userAgent = `agent-device-cli/${options.clientVersion}`;
    this.send = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * One call: JSON in and out, NoMac's refusal as an AppError. A read, a stop, a request with a key,
   * and anything NoMac answered 429 are sent again up to three times while NoMac is busy or silent.
   */
  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!this.auth) {
      throw new AppError(
        'UNAUTHORIZED',
        "The NoMac provider needs NOMAC_API_KEY, a NoMac account's API key.",
        {
          hint: 'Create one at https://nomac.app/dashboard, then restart the daemon (agent-device daemon stop).',
        },
      );
    }
    const repeatable = method === 'GET' || method === 'DELETE' || Boolean(options.idempotencyKey);
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted();
      const more = attempt < 4;
      const outcome = await this.attempt<T>(method, path, options, {
        network: repeatable && more,
        busy: more,
      });
      if ('value' in outcome) return outcome.value;
      await sleep(outcome.retryAfterMs ?? attempt * 1000, undefined, { signal: options.signal });
    }
  }

  /**
   * One try: NoMac's answer, or a wait before the next try (a lost answer to a request that may be sent
   * again; a busy NoMac for those, or for anything it answered 429), or the error that ends the request.
   */
  private async attempt<T>(
    method: string,
    path: string,
    options: RequestOptions,
    retry: { network: boolean; busy: boolean },
  ): Promise<{ value: T } | { retryAfterMs?: number }> {
    let response: Response;
    try {
      response = await this.send(`${this.base}${path}`, {
        method,
        headers: this.headers(options),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: anySignal(options.signal, AbortSignal.timeout(options.timeoutMs ?? 90_000)),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (retry.network) return {};
      throw new AppError(
        'COMMAND_FAILED',
        'NoMac did not answer.',
        { hint: 'Check the network, then retry.' },
        error,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { value: payload as T };
    if (PASSING.has(response.status) && (retry.network || (retry.busy && response.status === 429)))
      return { retryAfterMs: retryAfter(response) };
    throw nomacError(response.status, payload);
  }

  private headers(options: RequestOptions): Record<string, string> {
    return {
      authorization: this.auth,
      'user-agent': this.userAgent,
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
  }

  async startPhone(
    requestKey: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<NomacPhone> {
    return (
      await this.request<{ session: NomacPhone }>('POST', SESSIONS, {
        body,
        idempotencyKey: requestKey,
        signal,
      })
    ).session;
  }

  async readPhone(id: string, signal?: AbortSignal): Promise<NomacPhone> {
    return (
      await this.request<{ session: NomacPhone }>('GET', `${SESSIONS}/${encodeURIComponent(id)}`, {
        signal,
      })
    ).session;
  }

  async stopPhone(id: string, signal?: AbortSignal): Promise<NomacPhone> {
    return (
      await this.request<{ session: NomacPhone }>(
        'DELETE',
        `${SESSIONS}/${encodeURIComponent(id)}`,
        { signal },
      )
    ).session;
  }

  /** The phones with a label: a lease's own, to find after the daemon lost track of it. */
  async phonesWithLabel(label: string, signal?: AbortSignal): Promise<NomacPhone[]> {
    return (
      await this.request<{ sessions: NomacPhone[] }>(
        'GET',
        `${SESSIONS}?label=${encodeURIComponent(label)}`,
        { signal },
      )
    ).sessions;
  }

  /**
   * Runs one of simulator-use's tools on the phone and waits for its result. A long build that hands
   * back a job is followed with job_status until it ends.
   */
  async tool(
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<NomacToolResult> {
    let result = await this.call(id, name, args, signal);
    for (let rounds = 0; rounds < 120 && !result.isError; rounds++) {
      const job = JOB.exec(result.text)?.[1];
      if (!job) break;
      result = await this.call(id, 'job_status', { job_id: job }, signal);
    }
    return result;
  }

  private async call(
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<NomacToolResult> {
    const path = `${SESSIONS}/${encodeURIComponent(id)}`;
    let answer = await this.request<Record<string, any>>(
      'POST',
      `${path}/tools/${encodeURIComponent(name)}`,
      {
        body: args,
        idempotencyKey: nomacRequestKey(name),
        signal,
      },
    );
    while (answer.state === 'running' && typeof answer.id === 'string') {
      await sleep(400, undefined, { signal });
      answer = await this.request<Record<string, any>>('GET', `${path}/calls/${answer.id}`, {
        signal,
      });
    }
    if (answer.state === 'cancelled')
      return { text: `${name} was cancelled.`, content: [], isError: true };
    if (!answer.result) {
      throw new AppError(
        'COMMAND_FAILED',
        `NoMac's phone could not run ${name}: ${answer.message ?? answer.error ?? answer.state}.`,
        {
          tool: name,
        },
      );
    }
    const content = (answer.result.content ?? []) as NomacToolContent[];
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    return { text, content, isError: Boolean(answer.result.isError) };
  }

  /** A file an answer names, by its link (no credential: the link is it). */
  async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    if (!url.startsWith(`${this.base}/`))
      throw new AppError('COMMAND_FAILED', 'NoMac named a file somewhere else.', { url });
    const response = await this.send(url, {
      signal: anySignal(signal, AbortSignal.timeout(60_000)),
    });
    if (!response.ok)
      throw new AppError(
        'COMMAND_FAILED',
        `NoMac could not hand over a file (${response.status}).`,
      );
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * An archive (a .tar.gz or .zip of a .app built for the Simulator) into the phone's workspace under
   * `name`: uploaded to storage, then unpacked. Answers the unpacked root and the .app in it.
   */
  async uploadArchive(
    id: string,
    archive: Buffer,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ root: string; app?: string }> {
    const path = `${SESSIONS}/${encodeURIComponent(id)}`;
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const link = await this.request<{ upload_url: string }>('POST', `${path}/sync/upload`, {
      body: { size: archive.length, sha256 },
      signal,
    });
    const put = await this.send(link.upload_url, {
      method: 'PUT',
      body: new Uint8Array(archive),
      signal: anySignal(signal, AbortSignal.timeout(30 * 60_000)),
    });
    if (!put.ok)
      throw new AppError('COMMAND_FAILED', `NoMac's storage refused the upload (${put.status}).`);
    const key = nomacRequestKey('fetch');
    for (;;) {
      const answer = await this.request<Record<string, any>>('POST', `${path}/sync/fetch`, {
        body: { sha256, name },
        idempotencyKey: key,
        signal,
      });
      if (answer.state === 'running') {
        await sleep(1000, undefined, { signal });
        continue;
      }
      if (answer.state !== 'done') {
        throw new AppError(
          'COMMAND_FAILED',
          `NoMac's phone could not unpack the app: ${answer.message ?? answer.error ?? answer.state}.`,
        );
      }
      return {
        root: String(answer.root),
        ...(typeof answer.app === 'string' ? { app: answer.app } : {}),
      };
    }
  }
}

/** NoMac's refusal in agent-device's terms, NoMac's own code and words kept. */
function nomacError(status: number, payload: Record<string, unknown>): AppError {
  const error = (payload.error ?? {}) as { code?: string; message?: string };
  const message = error.message ?? `NoMac answered ${status}.`;
  const details = { nomacCode: error.code, status };
  if (status === 401 || status === 403) {
    return new AppError('UNAUTHORIZED', message, {
      ...details,
      hint: "Check NOMAC_API_KEY: the account's key, from https://nomac.app/dashboard or `nomac login`.",
    });
  }
  if (status === 402)
    return new AppError('COMMAND_FAILED', message, {
      ...details,
      hint: 'Add credit at https://nomac.app/dashboard.',
    });
  if (status === 404) return new AppError('DEVICE_NOT_FOUND', message, details);
  if (status === 400 || status === 422) return new AppError('INVALID_ARGS', message, details);
  return new AppError('COMMAND_FAILED', message, details);
}

function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : undefined;
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}
