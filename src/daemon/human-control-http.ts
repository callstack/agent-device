import type http from 'node:http';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { readNodeHttpRequestBody } from '../utils/node-http.ts';
import { timingSafeStringEqual } from '../utils/timing-safe-equal.ts';
import { sendRestJsonError } from './http-errors.ts';
import {
  parseHumanControlHoldInput,
  type HumanControlHold,
  type HumanControlHoldInput,
} from './human-control-contract.ts';
import {
  HUMAN_CONTROL_HTTP_PREFIX,
  releaseHumanControlHold,
  type HumanControlRegistry,
} from './human-control.ts';

const MAX_HUMAN_CONTROL_BODY_BYTES = 16 * 1024;

type HumanControlHttpRoute =
  | { kind: 'list' }
  | { kind: 'upsert'; holdId: string }
  | { kind: 'remove'; holdId: string }
  | { kind: 'unsupported' };

export function tryHandleHumanControlHttpRoute(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  expectedToken: string;
  registry: HumanControlRegistry;
  onHoldReleased?: (hold: HumanControlHold) => void;
}): boolean {
  const route = resolveHumanControlRoute(params.req);
  if (!route) return false;
  void handleHumanControlRoute(route, params);
  return true;
}

async function handleHumanControlRoute(
  route: HumanControlHttpRoute,
  params: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    expectedToken: string;
    registry: HumanControlRegistry;
    onHoldReleased?: (hold: HumanControlHold) => void;
  },
): Promise<void> {
  const { req, res, expectedToken, registry, onHoldReleased } = params;
  try {
    assertAuthorized(req, expectedToken);
    switch (route.kind) {
      case 'list':
        sendJson(res, { ok: true, holds: registry.list() });
        return;
      case 'upsert': {
        const input = await readHoldInput(req);
        const hold = registry.upsert(route.holdId, input);
        await registry.waitForDeviceIdle(hold.scope.deviceKey);
        sendJson(res, { ok: true, hold, state: 'active' });
        return;
      }
      case 'remove': {
        const hold = releaseHumanControlHold(registry, route.holdId);
        if (hold) onHoldReleased?.(hold);
        sendJson(res, { ok: true, released: Boolean(hold), ...(hold ? { hold } : {}) });
        return;
      }
      case 'unsupported':
        res.statusCode = 405;
        res.setHeader('allow', 'GET, PUT, DELETE');
        sendJson(res, { ok: false, error: 'Method not allowed', code: 'INVALID_ARGS' });
        return;
    }
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

function resolveHumanControlRoute(req: http.IncomingMessage): HumanControlHttpRoute | null {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === HUMAN_CONTROL_HTTP_PREFIX) {
    return req.method === 'GET' ? { kind: 'list' } : { kind: 'unsupported' };
  }
  if (!pathname.startsWith(`${HUMAN_CONTROL_HTTP_PREFIX}/`)) return null;
  const holdId = pathname.slice(HUMAN_CONTROL_HTTP_PREFIX.length + 1);
  if (!holdId || holdId.includes('/')) return { kind: 'unsupported' };
  if (req.method === 'PUT') return { kind: 'upsert', holdId };
  if (req.method === 'DELETE') return { kind: 'remove', holdId };
  return { kind: 'unsupported' };
}

async function readHoldInput(req: http.IncomingMessage): Promise<HumanControlHoldInput> {
  const raw = await readNodeHttpRequestBody(
    req,
    MAX_HUMAN_CONTROL_BODY_BYTES,
    'Human-control request body is too large.',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      'Human-control request body must be valid JSON.',
      undefined,
      error,
    );
  }
  return parseHumanControlHoldInput(parsed);
}

function assertAuthorized(req: http.IncomingMessage, expectedToken: string): void {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length)
    : '';
  const headerToken =
    typeof req.headers['x-agent-device-token'] === 'string'
      ? req.headers['x-agent-device-token']
      : '';
  const token = headerToken || bearer;
  if (!token || !timingSafeStringEqual(token, expectedToken)) {
    throw new AppError('UNAUTHORIZED', 'Invalid token');
  }
}

function sendJson(res: http.ServerResponse, body: Record<string, unknown>): void {
  res.statusCode ||= 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
