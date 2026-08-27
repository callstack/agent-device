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
  | { kind: 'invalid' }
  | { kind: 'unsupported' };

type HumanControlHttpParams = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  expectedToken: string;
  registry: HumanControlRegistry;
  onHoldReleased?: (hold: HumanControlHold) => void;
};

export function tryHandleHumanControlHttpRoute(params: HumanControlHttpParams): boolean {
  const route = resolveHumanControlRoute(params.req);
  if (!route) return false;
  void handleHumanControlRoute(route, params);
  return true;
}

async function handleHumanControlRoute(
  route: HumanControlHttpRoute,
  params: HumanControlHttpParams,
): Promise<void> {
  const { req, res, expectedToken } = params;
  try {
    assertAuthorized(req, expectedToken);
    await executeHumanControlRoute(route, params);
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

async function executeHumanControlRoute(
  route: HumanControlHttpRoute,
  params: HumanControlHttpParams,
): Promise<void> {
  switch (route.kind) {
    case 'list':
      sendJson(params.res, { ok: true, holds: params.registry.list() });
      return;
    case 'upsert':
      await upsertHumanControlHold(route.holdId, params);
      return;
    case 'remove':
      removeHumanControlHold(route.holdId, params);
      return;
    case 'unsupported':
      sendMethodNotAllowed(params.res);
      return;
    case 'invalid':
      throw new AppError('INVALID_ARGS', 'Invalid request URL.');
  }
}

async function upsertHumanControlHold(
  holdId: string,
  params: HumanControlHttpParams,
): Promise<void> {
  const input = await readHoldInput(params.req);
  const hold = await params.registry.upsert(holdId, input);
  sendJson(params.res, { ok: true, hold, state: 'active' });
}

function removeHumanControlHold(holdId: string, params: HumanControlHttpParams): void {
  const hold = releaseHumanControlHold(params.registry, holdId);
  if (hold) params.onHoldReleased?.(hold);
  sendJson(params.res, { ok: true, released: Boolean(hold), ...(hold ? { hold } : {}) });
}

function sendMethodNotAllowed(res: http.ServerResponse): void {
  res.statusCode = 405;
  res.setHeader('allow', 'GET, PUT, DELETE');
  sendJson(res, { ok: false, error: 'Method not allowed', code: 'INVALID_ARGS' });
}

function resolveHumanControlRoute(req: http.IncomingMessage): HumanControlHttpRoute | null {
  const pathname = parseRequestPathname(req.url);
  if (pathname === null) return { kind: 'invalid' };
  return resolveHumanControlPathRoute(pathname, req.method);
}

function resolveHumanControlPathRoute(
  pathname: string,
  method: string | undefined,
): HumanControlHttpRoute | null {
  if (pathname === HUMAN_CONTROL_HTTP_PREFIX) {
    return method === 'GET' ? { kind: 'list' } : { kind: 'unsupported' };
  }
  if (!pathname.startsWith(`${HUMAN_CONTROL_HTTP_PREFIX}/`)) return null;
  const holdId = pathname.slice(HUMAN_CONTROL_HTTP_PREFIX.length + 1);
  if (!holdId || holdId.includes('/')) return { kind: 'unsupported' };
  if (method === 'PUT') return { kind: 'upsert', holdId };
  if (method === 'DELETE') return { kind: 'remove', holdId };
  return { kind: 'unsupported' };
}

function parseRequestPathname(url: string | undefined): string | null {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
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
