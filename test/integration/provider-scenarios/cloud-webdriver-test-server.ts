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

  constructor() {
    const server = http.createServer();
    server.on('request', async (req, res) => await this.handle(req, res));
    cloudWebDriverHttpServers.set(this, server);
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

const cloudWebDriverHttpServers = new WeakMap<CloudWebDriverTestServer, http.Server>();

export type StartedCloudWebDriverTestServer<T extends CloudWebDriverTestServer> = T & {
  close(): Promise<void>;
};

export async function startCloudWebDriverTestServer<T extends CloudWebDriverTestServer>(
  testServer: T,
): Promise<StartedCloudWebDriverTestServer<T>> {
  const server = getCloudWebDriverHttpServer(testServer);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  testServer.url = `http://127.0.0.1:${address.port}`;
  return Object.assign(testServer, {
    close: async () => await closeCloudWebDriverTestServer(testServer),
  });
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

function getCloudWebDriverHttpServer(testServer: CloudWebDriverTestServer): http.Server {
  const server = cloudWebDriverHttpServers.get(testServer);
  assert.ok(server);
  return server;
}

async function closeCloudWebDriverTestServer(testServer: CloudWebDriverTestServer): Promise<void> {
  const server = getCloudWebDriverHttpServer(testServer);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
