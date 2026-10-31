/** The request bodies and responses of the Revyl execution API this runtime drives. */

import type { RevylPlatform } from './device.ts';

export type RevylStartDeviceRequest = Readonly<{
  platform: RevylPlatform;
  is_simulation: true;
  /**
   * The caller's own canonical session id. Revyl accepts it as the session's identity, which is what
   * lets the runtime name the session it rented for one lease after a restart.
   */
  session_id?: string;
  idle_timeout_seconds?: number;
  app_url?: string;
  device_model?: string;
  os_version?: string;
}>;

export type RevylStartDeviceResponse = Readonly<{
  status?: string;
  platform?: string;
  session_id?: string | null;
  workflow_run_id?: string | null;
  error?: string | null;
  message?: string | null;
  trace_id?: string | null;
}>;

/**
 * `ready` reports a worker the session can route actions to. The other statuses are terminal:
 * no later poll turns them ready.
 */
export type RevylWorkerConnection = Readonly<{
  status?: string;
  workflow_run_id?: string;
  worker_ws_url?: string | null;
  message?: string | null;
}>;

export type RevylWorkerHealth = Readonly<{
  status?: string;
  device_connected?: boolean;
  platform?: string;
  screen_width?: number;
  screen_height?: number;
}>;

export type RevylDeviceSessionStopResponse = Readonly<{
  success?: boolean;
  request_accepted?: boolean;
  session_id?: string;
  status?: string;
  message?: string;
}>;

/**
 * A device-proxy action result. `install` reports its verdict as `Success`, capitalized, where
 * every other action uses `success`; a refusal arrives in a 200 body rather than a status code.
 */
export type RevylWorkerActionResponse = Readonly<{
  success?: boolean;
  Success?: boolean;
  action?: string;
  error?: string | null;
  /** The action may have reached the device even though its report failed. */
  execution_uncertain?: boolean;
  bundle_id?: string | null;
  package_name?: string | null;
}>;
