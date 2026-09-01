import { isMacOs } from '@agent-device/kernel/device';
import type { DaemonResponse, SessionState } from '../../types.ts';
import { errorResponse } from '../../response.ts';

export function unsupportedMacOsDesktopSurfaceInteraction(
  session: SessionState,
  command: 'click' | 'press' | 'fill' | 'longpress' | 'hover',
): DaemonResponse | null {
  if (!isMacOs(session.device)) {
    return null;
  }
  if (session.surface !== 'desktop' && session.surface !== 'menubar') {
    return null;
  }
  if (session.surface === 'menubar' && (command === 'click' || command === 'press')) {
    return null;
  }
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `${command} is not supported on macOS ${session.surface} sessions yet. Open an app session to act, or use the ${session.surface} surface to inspect.`,
  );
}
