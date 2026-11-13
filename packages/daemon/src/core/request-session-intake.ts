import { namesSessionExplicitly } from '@agent-device/kernel/record';
import type { DaemonRequest } from './daemon-request.ts';

/**
 * What a transport takes from a request's session: the name it runs under, and whether the caller
 * named one at all. A missing session runs under `default`. A blank one names no session but keeps
 * its literal, so a command that validates the name, such as a web open, still refuses it. The Node
 * client always sends `default` and reports the omission in `meta.sessionExplicit`, so the literal
 * stays and cwd-scoped routing keeps reading it. A caller on neither carrier predates the fact and
 * counts as named.
 */
export function resolveRequestSessionAtIntake(request: {
  session?: unknown;
  flags?: { session?: unknown } | Record<string, unknown>;
  meta?: { sessionExplicit?: boolean | undefined };
}): Pick<DaemonRequest, 'session' | 'internal'> {
  const literal = typeof request.session === 'string' ? request.session : undefined;
  const named = literal !== undefined && literal.trim().length > 0;
  const omitted =
    !named || (request.meta?.sessionExplicit === false && !namesSessionExplicitly(request));
  return {
    session: literal ?? 'default',
    ...(omitted ? { internal: { sessionOmitted: true } } : {}),
  };
}
