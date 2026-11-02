import { namesSessionExplicitly } from '@agent-device/kernel/record';
import type { DaemonRequest } from './daemon-request.ts';

/**
 * What a transport takes from a request's session: the name it runs under, and whether the caller
 * named one at all. A missing or blank session runs under `default`. The Node client always sends
 * that literal and reports the omission in `meta.sessionExplicit`, so the literal stays and
 * cwd-scoped routing keeps reading it. A caller on neither carrier predates the fact and counts as
 * named.
 */
export function resolveRequestSessionAtIntake(request: {
  session?: unknown;
  flags?: { session?: unknown } | Record<string, unknown>;
  meta?: { sessionExplicit?: boolean | undefined };
}): Pick<DaemonRequest, 'session' | 'internal'> {
  const { session } = request;
  const named = typeof session === 'string' && session.trim().length > 0;
  const omitted =
    !named || (request.meta?.sessionExplicit === false && !namesSessionExplicitly(request));
  return {
    session: named ? session : 'default',
    ...(omitted ? { internal: { sessionOmitted: true } } : {}),
  };
}
