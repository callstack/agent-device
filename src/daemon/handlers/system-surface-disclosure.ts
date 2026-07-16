import type { SnapshotState } from '../../kernel/snapshot.ts';
import { systemSurfaceDisclosure } from '../../snapshot/system-surface-disclosure.ts';
import type { DaemonResponse } from '../types.ts';

/**
 * Append the occluding-system-surface disclosure to a selector-route response whose consumed
 * snapshot was a system surface (notification shade / quick settings). Both found and not-found
 * outcomes must explain that app content is occluded: a match found inside the shade is not app
 * content, and a miss is expected while the shade covers the app.
 */
export function withSystemSurfaceDisclosure(
  response: DaemonResponse,
  snapshot: Pick<SnapshotState, 'systemSurfaceOnly'> | undefined,
): DaemonResponse {
  const disclosure = systemSurfaceDisclosure(snapshot);
  if (!disclosure) return response;
  if (response.ok) {
    const warning = appended(response.data?.warning, disclosure);
    return { ...response, data: { ...response.data, warning } };
  }
  const details = response.error.details ?? {};
  return {
    ...response,
    error: { ...response.error, details: { ...details, hint: appended(details.hint, disclosure) } },
  };
}

function appended(existing: unknown, disclosure: string): string {
  return typeof existing === 'string' && existing.trim() !== ''
    ? `${existing}\n${disclosure}`
    : disclosure;
}
