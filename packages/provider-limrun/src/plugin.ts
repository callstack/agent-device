import path from 'node:path';
import type { ReasonTable } from '@agent-device/kernel/errors';
import type { PluginConnection, ProviderAgentDevicePlugin } from 'agent-device/plugins';
import type { DeviceProviderPluginHost } from 'agent-device/plugins/device-host';
import {
  LIMRUN_CREDENTIAL_DORMANCY,
  limrunCredentialDeclaration,
  readLimrunCredentials,
} from './credentials.ts';
import { LIMRUN_CONNECTION_CAPABILITIES, LIMRUN_PROVIDER } from './device.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

export type LimrunPluginOptions = Readonly<{
  /**
   * Builds the runtime's host and platform adapters for one setup host. Defaults to the adapters
   * the host's own capabilities answer.
   */
  createDependencies?(
    host: DeviceProviderPluginHost,
  ): LimrunRuntimeDependencies | Promise<LimrunRuntimeDependencies>;
}>;

const ATTACHMENT_REASONS = {
  // The hosted attachment deadline passed or could not be validated.
  expired: { reason: 'limrun_hosted_attachment_expired' },
  invalidDeadline: { reason: 'limrun_hosted_attachment_invalid_deadline' },
  // A hosted attachment cannot run with an ambient Limrun account key.
  accountKeyConflict: { reason: 'limrun_hosted_attachment_account_key_conflict' },
} as const satisfies ReasonTable<'limrun provider'>;

const LIMRUN_CONNECTION: PluginConnection = {
  capabilities: LIMRUN_CONNECTION_CAPABILITIES,
  // The connect callbacks load when the first `connect` runs them, so a process that only lists or
  // fingerprints this provider evaluates none of them.
  resolve: async (context) =>
    await (await import('./connection.ts')).createLimrunConnection().resolve(context),
  verify: async (context) =>
    await (await import('./connection.ts')).createLimrunConnection().verify(context),
};

/**
 * Limrun as a version 3 plugin: instances are rented from the Limrun API and driven through their
 * own ADB tunnel or Simulator bridge.
 *
 * The credentials are read from the setup host's environment, so the plugin declares exactly the
 * variables it reads there, narrowed per lease backend. Only this module's declaration is needed to
 * list, fingerprint, or route a `connect` to the provider: the connection's flags and credential
 * reading, the runtime, and its host adapters all load in the path that asks for them.
 */
export function limrunPlugin(options: LimrunPluginOptions = {}): ProviderAgentDevicePlugin {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'provider',
        provider: LIMRUN_PROVIDER,
        credentials: limrunCredentialDeclaration(),
        connection: LIMRUN_CONNECTION,
        setup: async (host: DeviceProviderPluginHost) => {
          const credentials = readLimrunCredentials(host.env);
          if (!credentials) return { dormant: LIMRUN_CREDENTIAL_DORMANCY };
          const deadline = host.env.LIMRUN_HOSTED_ATTACHMENT_DEADLINE;
          const expiresAt = deadline === undefined ? undefined : Date.parse(deadline);
          const dormant = hostedAttachmentDormancy(expiresAt, Boolean(credentials.apiKey));
          if (dormant) return { dormant };
          const [register, dependencies] = await Promise.all([
            import('./runtime.ts'),
            options.createDependencies
              ? options.createDependencies(host)
              : import('./host-dependencies.ts').then((module) =>
                  module.createLimrunRuntimeDependencies(host),
                ),
          ]);
          const registration = register.createLimrunRuntime(
            {
              ...credentials,
              ...(host.stateDir === undefined
                ? {}
                : {
                    // HAR captures land beside the session files, under the daemon's state dir.
                    networkHarDir: path.join(host.stateDir, 'network-har'),
                  }),
            },
            dependencies,
            { includePlatformModule: true },
          );
          if (expiresAt === undefined) {
            await registration.runtime.prepareRentalRecovery();
            return registration;
          }
          const { refuseHostedInstanceRedirects } = await import('./hosted-instance-http.ts');
          const tokens = [credentials.instances?.ios?.token, credentials.instances?.android?.token];
          const restoreFetch = refuseHostedInstanceRedirects(
            tokens.filter((token): token is string => token !== undefined),
          );
          try {
            await registration.runtime.prepareRentalRecovery();
          } catch (error) {
            restoreFetch();
            throw error;
          }
          const cancelShutdown = shutdownHostedRuntimeAt(expiresAt, () =>
            registration.runtime.shutdown(),
          );
          return {
            ...registration,
            dispose: () => {
              cancelShutdown();
              restoreFetch();
            },
          };
        },
      },
    ],
  };
}

function hostedAttachmentDormancy(expiresAt: number | undefined, hasAccountKey: boolean) {
  if (expiresAt === undefined) return undefined;
  if (!Number.isFinite(expiresAt)) {
    return {
      reason: ATTACHMENT_REASONS.invalidDeadline.reason,
      message: 'The scoped Limrun attachment deadline could not be parsed.',
    };
  }
  if (expiresAt <= Date.now()) {
    return {
      reason: ATTACHMENT_REASONS.expired.reason,
      message: 'The scoped Limrun attachment deadline has passed.',
    };
  }
  if (hasAccountKey) {
    return {
      reason: ATTACHMENT_REASONS.accountKeyConflict.reason,
      message: 'The scoped Limrun attachment cannot run with a Limrun account key.',
      hint: 'Unset LIMRUN_API_KEY before starting the hosted attachment daemon.',
    };
  }
}

function shutdownHostedRuntimeAt(deadline: number, close: () => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      void close().catch(() => {});
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  arm();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
