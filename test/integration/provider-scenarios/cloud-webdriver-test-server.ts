import assert from 'node:assert/strict';
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

export type CloudWebDriverHttpCall = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body?: unknown;
};

export abstract class CloudWebDriverTestServer {
  readonly calls: CloudWebDriverHttpCall[] = [];
  url = '';

  private readonly server = http.createServer();

  constructor() {
    this.server.on('request', async (req, res) => await this.handle(req, res));
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    assert.ok(address && typeof address === 'object');
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  protected abstract respond(call: CloudWebDriverHttpCall, res: ServerResponse): void;

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readRequestBody(req);
    const call: CloudWebDriverHttpCall = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      ...(body === undefined ? {} : { body }),
    };
    this.calls.push(call);
    this.respond(call, res);
  }
}

export function writeCloudWebDriverTestJson(
  res: ServerResponse,
  body: unknown,
  status = 200,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (req.headers['content-type']?.startsWith('multipart/form-data') === true) {
    return { multipartBytes: buffer.length };
  }
  const text = buffer.toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}
