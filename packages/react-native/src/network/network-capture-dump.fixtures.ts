import vm from 'node:vm';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';

type Frame = { opcode: number; fin: boolean; payload: Buffer };

/**
 * Reads WebSocket frames from a byte stream, including the 16-bit and 64-bit extended lengths and
 * the continuation frames undici emits when one send is split across TCP chunks.
 */
class FrameReader {
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentOpcode = 0;

  push(chunk: Buffer): Frame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const read = this.#readFrame();
      if (!read) break;
      this.#buffer = read.rest;
      if (!read.frame.fin && read.frame.opcode !== 0) {
        this.#fragmentOpcode = read.frame.opcode;
        this.#fragments.push(read.frame.payload);
        continue;
      }
      if (read.frame.opcode === 0) {
        this.#fragments.push(read.frame.payload);
        if (!read.frame.fin) continue;
        frames.push({
          opcode: this.#fragmentOpcode,
          fin: true,
          payload: Buffer.concat(this.#fragments),
        });
        this.#fragments = [];
        continue;
      }
      frames.push(read.frame);
    }
    return frames;
  }

  #readFrame(): { frame: Frame; rest: Buffer } | null {
    const buffer = this.#buffer;
    if (buffer.length < 2) return null;
    const fin = (buffer[0]! & 0x80) !== 0;
    const opcode = buffer[0]! & 0x0f;
    if ((buffer[1]! & 0x80) === 0) return null;
    const marker = buffer[1]! & 0x7f;
    let length = marker;
    let offset = 2;
    if (marker === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (marker === 127) {
      if (buffer.length < 10) return null;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (buffer.length < offset + 4 + length) return null;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
    return { frame: { opcode, fin, payload }, rest: buffer.subarray(offset + 4 + length) };
  }
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** The fetch/XMLHttpRequest surfaces and the app's own request entry point. */
const APP_RUNTIME_SOURCE = `
  var Headers = function (init) {
    var map = new Map(Object.keys(init || {}).map(function (name) { return [name.toLowerCase(), init[name]]; }));
    this.get = function (name) { return map.get(String(name).toLowerCase()); };
    this.forEach = function (fn) { map.forEach(function (value, name) { fn(value, name); }); };
  };
  var Body = function (text) { this.text = function () { return Promise.resolve(text); }; };
  Body.prototype.clone = function () { return this; };
  globalThis.__pending = {};

  // An XMLHttpRequest with the real surface the capture instruments: readyState transitions,
  // readystatechange/load/error events, setRequestHeader accumulation, and getAllResponseHeaders.
  var XHR = function () {
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this.responseType = '';
    this._listeners = {};
    this._headers = {};
  };
  XHR.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  XHR.prototype._emit = function (type) {
    var listeners = this._listeners[type] || [];
    for (var i = 0; i < listeners.length; i += 1) listeners[i].call(this);
  };
  XHR.prototype.open = function (method, url) {
    this._method = method;
    this._url = url;
    this.readyState = 1;
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    this._headers[name] = value;
  };
  XHR.prototype.getAllResponseHeaders = function () {
    var spec = globalThis.__pending[this._url] || {};
    var lines = Object.keys(spec.responseHeaders || {}).map(function (name) {
      return name + ': ' + spec.responseHeaders[name];
    });
    return lines.length ? lines.join('\\n') + '\\n' : '';
  };
  XHR.prototype.send = function () {
    var xhr = this;
    var spec = globalThis.__pending[xhr._url] || {};
    Promise.resolve().then(function () {
      if (spec.reject) {
        xhr.__failed = spec.reject;
        xhr.readyState = 4;
        xhr._emit('readystatechange');
        xhr._emit('error');
        return;
      }
      xhr.status = spec.status;
      xhr.responseText = spec.body || '';
      xhr.readyState = 4;
      xhr._emit('readystatechange');
      xhr._emit('load');
    });
  };
  globalThis.XMLHttpRequest = XHR;

  // fetch polyfilled on XMLHttpRequest, the way whatwg-fetch does it: open, headers, and send
  // all run synchronously inside the call, and the promise settles on readystatechange.
  globalThis.fetch = function (url, init) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open((init && init.method) || 'GET', url);
      var headers = (init && init.headers) || {};
      Object.keys(headers).forEach(function (name) {
        xhr.setRequestHeader(name, headers[name]);
      });
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState !== 4) return;
        if (xhr.__failed) {
          reject(new Error(xhr.__failed));
          return;
        }
        var spec = globalThis.__pending[url] || {};
        resolve({
          status: xhr.status,
          url: url,
          headers: new Headers(spec.responseHeaders),
          clone: function () { return new Body(xhr.responseText); }
        });
      });
      xhr.send(init && init.body);
    });
  };
  globalThis.__settled = Promise.resolve('idle');
  globalThis.__request = function (url, options) {
    var promise = fetch(url, options);
    globalThis.__settled = promise.then(function () { return 'ok'; }, function () { return 'error'; });
    return promise;
  };
  globalThis.__xhr = function (url) {
    var request = new XMLHttpRequest();
    request.open('GET', url);
    request.send();
    globalThis.__settled = new Promise(function (resolve) {
      request.addEventListener('readystatechange', function () {
        if (request.readyState === 4) resolve(request.status ? 'ok' : 'error');
      });
    });
  };
`;

const DEFAULT_XHR_RESPONSE: FakeAppResponse = { status: 200, body: 'xhr-ok' };

/** A scripted response the fake app can request. */
export type FakeAppResponse = {
  status?: number;
  body?: string;
  responseHeaders?: Record<string, string>;
  reject?: string;
};

/** The one app runtime behind every debugger connection this fake dev server accepts. */
export type FakeAppRuntime = Readonly<{
  /** The app issues its own request for a scripted response and lets it finish. */
  request(url: string, response: FakeAppResponse, options?: unknown): Promise<void>;
  /** The app performs a direct XMLHttpRequest GET and lets it finish. */
  xhrRequest(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
}>;

export type FakeMetroDevServer = Readonly<{
  serverUrl: string;
  app: FakeAppRuntime;
  /** Inspector page ids whose debugger connection ran an expression, in connection order. */
  hookedPages: string[];
  close(): Promise<void>;
}>;

/**
 * A React Native dev server that lists inspector targets and answers `Runtime.evaluate` by running
 * the expression in one in-process JavaScript runtime. Every debugger connection reaches that same
 * runtime, the way several DevTools sessions reach one Hermes instance, so a test can dump, drive
 * app traffic, and dump again over separate connections. `deviceNames` overrides the device each
 * listed target reports; two entries may share one name, the way two emulators of one system
 * image report one `Build.MODEL`-derived name.
 */
export async function fakeMetroDevServer(
  options: { appId?: string; devices?: number; deviceNames?: readonly string[] } = {},
): Promise<FakeMetroDevServer> {
  const appId = options.appId ?? 'com.example.app';
  const devices = options.devices ?? 1;
  const deviceName = (page: number) => options.deviceNames?.[page] ?? `Fake Device ${page + 1}`;
  const hookedPages: string[] = [];
  const app = new FakeAppRuntimeState();
  const sockets = new Set<Duplex>();
  const server = createServer((req, res) => {
    if (req.url !== '/json/list') {
      res.writeHead(404).end();
      return;
    }
    const port = (server.address() as AddressInfo).port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        Array.from({ length: devices }, (_, page) => ({
          id: `device-${page + 1}-1`,
          title: 'React Native',
          description: 'React Native Bridgeless [C++ connection]',
          appId,
          deviceName: deviceName(page),
          reactNative: { logicalDeviceId: `device-${page + 1}` },
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?page=device-${page + 1}-1`,
        })),
      ),
    );
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    const page = /page=([^&]+)/.exec(req.url ?? '')?.[1] ?? req.url ?? '';
    if (!hookedPages.includes(page)) hookedPages.push(page);
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        const message = JSON.parse(frame.payload.toString('utf8')) as {
          id: number;
          method: string;
          params?: { expression?: string };
        };
        if (message.method !== 'Runtime.evaluate') {
          // Everything else answers with an empty result, the way a real runtime replies to
          // Runtime.enable / Runtime.evaluate failures / Runtime.detach.
          if (socket.writable) {
            socket.write(textFrame(JSON.stringify({ id: message.id, result: {} })));
          }
          continue;
        }
        void app
          .evaluate<unknown>(message.params?.expression ?? '')
          .then(
            (value) => ({ id: message.id, result: { result: { value } } }),
            (error: unknown) => ({
              id: message.id,
              result: {
                exceptionDetails: { text: 'Uncaught', exception: { description: String(error) } },
              },
            }),
          )
          .then((reply) => {
            if (socket.writable) socket.write(textFrame(JSON.stringify(reply)));
          });
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    serverUrl: `http://127.0.0.1:${port}`,
    app,
    hookedPages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      // Target-close leaves the target's keep-alive HTTP connection behind; without this the
      // server waits out its 5s keep-alive timeout before 'close'.
      server.closeAllConnections();
      await once(server, 'close');
    },
  };
}

class FakeAppRuntimeState implements FakeAppRuntime {
  readonly #context: vm.Context;

  constructor() {
    this.#context = vm.createContext({
      Date,
      JSON,
      Math,
      Object,
      String,
      Array,
      Promise,
      Number,
      RegExp,
      Map,
      URLSearchParams,
      ArrayBuffer,
      console,
    });
    vm.runInContext('globalThis.globalThis = globalThis;', this.#context);
    vm.runInContext(APP_RUNTIME_SOURCE, this.#context);
  }

  async request(
    url: string,
    response: FakeAppResponse,
    options: unknown = undefined,
  ): Promise<void> {
    vm.runInContext(
      `globalThis.__pending[${JSON.stringify(url)}] = ${JSON.stringify(response)};
       globalThis.__settled = Promise.resolve('pending');
       globalThis.__request(${JSON.stringify(url)}, ${JSON.stringify(options ?? null)});`,
      this.#context,
    );
    await this.evaluate<string>('globalThis.__settled');
  }

  async xhrRequest(url: string): Promise<void> {
    vm.runInContext(
      `globalThis.__pending[${JSON.stringify(url)}] = globalThis.__pending[${JSON.stringify(url)}] || ${JSON.stringify(DEFAULT_XHR_RESPONSE)};
       globalThis.__settled = Promise.resolve('pending');
       globalThis.__xhr(${JSON.stringify(url)});`,
      this.#context,
    );
    await this.evaluate<string>('globalThis.__settled');
  }

  async evaluate<T>(expression: string): Promise<T> {
    const value: unknown = vm.runInContext(expression, this.#context);
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { then?: unknown }).then === 'function'
    ) {
      return (await value) as T;
    }
    return value as T;
  }
}
