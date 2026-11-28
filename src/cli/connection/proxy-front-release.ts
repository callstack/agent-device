import { createAgentDeviceClient } from '@agent-device/client';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { releaseProxyFrontConnectionLease } from '../commands/connection-lease-transaction.ts';
import type { ProxyFrontAttachment } from './cloud-connection-record.ts';

/** Ends the lease of an expired proxy front, through the hosted daemon that issued it. */
export async function releaseExpiredProxyFrontLease(
  host: HostEnvironment,
  state: RemoteConnectionState,
  attachment: ProxyFrontAttachment,
): Promise<void> {
  await releaseProxyFrontConnectionLease(createAgentDeviceClient({}, { host }), state, attachment);
}
