import { deflateSync } from 'node:zlib';
import type { NomacTreeNode } from './snapshot.ts';

/** One request the fake NoMac took, as a test reads it back. */
export type SeenRequest = {
  method: string;
  path: string;
  body?: any;
  key?: string | null;
  auth?: string | null;
};

/** A 1x1 PNG, so the screenshot path needs no JPEG decoder. */
export function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const SIGN_IN_TREE: NomacTreeNode[] = [
  {
    type: 'Application',
    role: 'AXApplication',
    AXLabel: 'Demo',
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        type: 'TextField',
        role: 'AXTextField',
        AXLabel: 'Email',
        AXUniqueId: 'email',
        enabled: true,
        frame: { x: 20, y: 180, width: 362, height: 44 },
      },
      {
        type: 'SecureTextField',
        role: 'AXTextField',
        subrole: 'AXSecureTextField',
        AXLabel: 'Password',
        AXUniqueId: 'password',
        enabled: true,
        frame: { x: 20, y: 236, width: 362, height: 44 },
      },
      {
        type: 'Switch',
        role: 'AXSwitch',
        AXLabel: 'Remember me',
        AXUniqueId: 'remember',
        AXValue: 0,
        enabled: true,
        frame: { x: 20, y: 292, width: 362, height: 44 },
      },
      {
        type: 'Button',
        role: 'AXButton',
        AXLabel: 'Sign In',
        AXUniqueId: 'signIn',
        enabled: true,
        traits: ['Button'],
        frame: { x: 20, y: 348, width: 362, height: 44 },
      },
      {
        type: 'StaticText',
        role: 'AXStaticText',
        AXLabel: 'Sign In',
        traits: ['Header'],
        frame: { x: 20, y: 100, width: 200, height: 40 },
      },
    ],
  },
];

/**
 * NoMac's REST API for phones, in memory: a phone that is ready after `readyAfter` reads, tools that
 * answer as simulator-use does, the tree behind a file link, and an upload then install.
 */
type FakePhone = {
  state: string;
  label?: string;
  device?: string;
  reads: number;
  failure_code?: string;
};

export function fakeNomac(
  options: {
    readyAfter?: number;
    failStart?: string;
    toolAnswers?: Record<
      string,
      (args: any) => { text: string; isError?: boolean; image?: string }
    >;
  } = {},
) {
  const seen: SeenRequest[] = [];
  const phones = new Map<string, FakePhone>();
  let next = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const answer = (text: string, isError = false, image?: string) =>
    json({
      state: 'done',
      result: {
        content: [
          { type: 'text', text },
          ...(image ? [{ type: 'image', data: image, mimeType: 'image/png' }] : []),
        ],
        ...(isError ? { isError } : {}),
      },
    });
  const notFound = (code: string, message: string) => json({ error: { code, message } }, 404);
  const startPhone = (body: { label?: string; device?: string }) => {
    const id = `ses_${String(++next).padStart(32, '0')}`;
    phones.set(id, {
      state: 'queued',
      label: body.label,
      device: body.device,
      reads: 0,
      ...(options.failStart ? { failure_code: options.failStart } : {}),
    });
    return json({ session: { id, state: 'queued', label: body.label, device: body.device } }, 202);
  };
  const listPhones = (label: string | null) =>
    json({
      sessions: [...phones]
        .filter(([, p]) => !label || p.label === label)
        .map(([id, p]) => ({ id, state: p.state, label: p.label })),
    });
  const readPhone = (id: string, phone: FakePhone) => {
    phone.reads++;
    if (phone.state === 'queued' && phone.reads >= (options.readyAfter ?? 1))
      phone.state = options.failStart ? 'failed' : 'ready';
    return json({
      session: {
        id,
        state: phone.state,
        label: phone.label,
        failure_code: phone.failure_code ?? null,
      },
    });
  };
  const toolAnswer = (tool: string, body: Record<string, unknown>) => {
    const custom = options.toolAnswers?.[tool];
    if (custom) {
      const out = custom(body);
      return answer(out.text, out.isError, out.image);
    }
    if (tool === 'ui_look' && body.full)
      return answer(
        'Demo · Sign In\nfull tree: https://nomac.test/api/v1/simulator/files/tree-token',
      );
    if (tool === 'ui_look' && body.screenshot)
      return answer('Demo · Sign In', false, tinyPng().toString('base64'));
    if (tool === 'app_control' && body.action === 'install')
      return answer('Installed Demo (dev.simtap.demo).');
    return answer(`${tool} done`);
  };
  /** One phone's routes: itself (read, stop), its sync and its tools. */
  const phoneRoute = (
    method: string,
    rest: string,
    id: string,
    phone: FakePhone,
    body: Record<string, unknown>,
  ) => {
    if (rest === '' && method === 'GET') return readPhone(id, phone);
    if (rest === '' && method === 'DELETE') {
      phone.state = 'stopping';
      return json({ session: { id, state: 'stopping' } }, 202);
    }
    if (rest === '/sync/upload')
      return json({ upload_url: 'https://storage.test/put?sig=1', archive: {} });
    if (rest === '/sync/fetch')
      return json({
        state: 'done',
        root: '/Volumes/nmw-x/src/agent-device-app',
        app: '/Volumes/nmw-x/src/agent-device-app/Demo.app',
      });
    const tool = /^\/tools\/([a-z_]+)$/.exec(rest)?.[1];
    if (tool) return toolAnswer(tool, body);
    return notFound('not_found', `No route ${method} /api/v1/simulator/sessions/${id}${rest}`);
  };
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    seen.push({
      method,
      path: `${url.pathname}${url.search}`,
      body,
      key: headers.get('idempotency-key'),
      auth: headers.get('authorization'),
    });
    if (url.host === 'storage.test') return new Response(null, { status: 200 });
    if (url.pathname.startsWith('/api/v1/simulator/files/'))
      return new Response(JSON.stringify(SIGN_IN_TREE));
    if (url.pathname === '/api/v1/simulator/sessions')
      return method === 'POST' ? startPhone(body) : listPhones(url.searchParams.get('label'));
    const m = /^\/api\/v1\/simulator\/sessions\/(ses_\d+)(\/.*)?$/.exec(url.pathname);
    const phone = m ? phones.get(m[1]!) : undefined;
    if (!m || !phone) return notFound('session_not_found', 'No phone with that id.');
    return phoneRoute(method, m[2] ?? '', m[1]!, phone, body ?? {});
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, seen, phones };
}
