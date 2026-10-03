import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';

export const NETWORK_RUNTIME_PROJECTION_PARITY = Object.freeze(
  (['dump', 'log'] as const).flatMap((action) =>
    (['summary', 'headers', 'body', 'all'] as const satisfies readonly NetworkIncludeMode[]).map(
      (include) => Object.freeze({ action, include }),
    ),
  ),
);
