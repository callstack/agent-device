import { AppError } from '@agent-device/kernel/errors';
import type { DoublespeedApiClient } from './api-client.ts';
import type { DoublespeedAppLogDescriptor } from './app-log-descriptor.ts';
import type { DoublespeedAppLogReader } from './app-log-poller.ts';
import type { DoublespeedAppLogReconnectOutcome } from './app-log-runtime.ts';
import { DOUBLESPEED_PROVIDER } from './device.ts';
import { createDoublespeedSessionClient } from './session-client.ts';

export async function reconnectDoublespeedAppLogReader(options: {
  api: DoublespeedApiClient;
  descriptor: DoublespeedAppLogDescriptor;
  signal?: AbortSignal;
}): Promise<DoublespeedAppLogReconnectOutcome> {
  let simulator;
  try {
    simulator = await options.api.getSimulator(options.descriptor.simulatorId, {
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof AppError && isMissingStatus(error)) return { status: 'missing' };
    throw error;
  }
  if (
    simulator.labels.provider !== DOUBLESPEED_PROVIDER ||
    simulator.labels.leaseId !== options.descriptor.leaseId
  ) {
    return { status: 'ownership-lost' };
  }
  if (!simulator.ready || !simulator.api_url) return { status: 'missing' };
  const client = createDoublespeedSessionClient(simulator.api_url);
  const reader: DoublespeedAppLogReader = {
    leaseId: options.descriptor.leaseId,
    simulatorId: options.descriptor.simulatorId,
    readLogs: async (appBundleId, lineLimit, signal) =>
      await client.appLogTail(appBundleId, lineLimit, signal),
    [Symbol.asyncDispose]: async () => undefined,
  };
  return { status: 'opened', reader };
}

function isMissingStatus(error: AppError): boolean {
  const status = (error.details as { status?: unknown } | undefined)?.status;
  return status === 404;
}
