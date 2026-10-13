import type { InteractionRouteInput } from './types.ts';
import type { SessionRef } from '../../session-state.ts';

export function bindInteractionSession<Params extends InteractionRouteInput>(
  params: Params,
): Params & { sessionRef: SessionRef | undefined } {
  return {
    ...params,
    sessionRef:
      'sessionRef' in params ? params.sessionRef : params.sessionStore.lookup(params.sessionName),
  };
}
