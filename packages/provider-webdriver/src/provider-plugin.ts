import type { CliFlags } from '@agent-device/contracts/command';
import type {
  CloudProviderProfileFields,
  ProviderConnectionVerification,
} from '@agent-device/contracts/remote';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { ProviderWebDriverDependencies } from './dependencies.ts';
import type { CloudWebDriverProviderDeclaration } from './providers.ts';
import type { CloudWebDriverPlatform, CloudWebDriverRuntimeOptions } from './runtime.ts';

/**
 * What a hosted WebDriver provider receives from the process that composes it. A bundled provider
 * and an installed plugin see the same shape: the environment, the client version the shared
 * engine stamps on provider requests, and a host-command runner for providers that drive a CLI.
 */
export type CloudWebDriverProviderHost = ProviderWebDriverDependencies &
  Readonly<{
    env: Readonly<Record<string, string | undefined>>;
  }>;

/** The engine options a provider contributes; the host supplies `clientVersion`. */
export type CloudWebDriverProviderOptions = Omit<CloudWebDriverRuntimeOptions, 'clientVersion'>;

/**
 * The profile fields a provider contributes to a generated connection profile. The composing
 * process adds connection identity, session defaults, and Metro settings, then persists it.
 */
export type CloudWebDriverConnectProfile = CloudProviderProfileFields &
  Readonly<{
    leaseProvider: string;
    leaseBackend?: LeaseBackend;
    platform: CloudWebDriverPlatform;
    device?: string;
  }>;

export type CloudWebDriverConnectionContext = Readonly<{
  flags: CliFlags;
  cwd: string;
}>;

export type CloudWebDriverConnectProfileResolution = {
  profile: CloudWebDriverConnectProfile;
  extraFlags?: Partial<CliFlags>;
};

/**
 * The `connect <provider>` callbacks: validate flags into a profile, then verify it read-only.
 * A bundled provider answers `resolve` asynchronously because it loads connect code on first use;
 * a daemon composing the runtime never evaluates it.
 */
export type CloudWebDriverConnection = Readonly<{
  resolve(
    context: CloudWebDriverConnectionContext,
  ): Promise<CloudWebDriverConnectProfileResolution> | CloudWebDriverConnectProfileResolution;
  verify(
    context: Pick<CloudWebDriverConnectionContext, 'flags'>,
  ): Promise<ProviderConnectionVerification>;
}>;

export type CloudWebDriverProviderRegistration = Readonly<{
  webDriver: CloudWebDriverProviderOptions;
  connection: CloudWebDriverConnection;
}>;

/** A provider shipped inside agent-device: its manifest-shaped declaration plus its factory. */
export type BundledCloudWebDriverProvider = Readonly<{
  declaration: CloudWebDriverProviderDeclaration;
  create(host: CloudWebDriverProviderHost): CloudWebDriverProviderRegistration;
}>;
