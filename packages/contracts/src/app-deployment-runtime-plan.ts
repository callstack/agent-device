import { defineUse } from './platform-runtime-operations.ts';

export const deployAppUse = defineUse({ required: ['deployApp'] });

export const uninstallAppUse = defineUse({ required: ['uninstallApp'] });

/**
 * Source installs retain their readiness precondition in the same request binding as
 * materialization and deployment, so the handler has one admission and one bind.
 */
export const readyMaterializeAndDeployAppUse = defineUse({
  required: ['ensureReady', 'materializeAppSource', 'deployMaterializedApp'],
});

/** Push follows the same one-binding rule as source installation. */
export const readySendPushNotificationUse = defineUse({
  required: ['ensureReady', 'sendPushNotification'],
});
