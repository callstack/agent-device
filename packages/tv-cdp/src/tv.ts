import type { CdpSession, CdpTarget } from './cdp.ts';
import type { RemoteKeys } from './keys.ts';
import type { PageLog } from './page-log.ts';

export type PageTunnel = Readonly<{
  target: CdpTarget;
  /** Runs when the tunnel ends, including when the TV sleeps or the network drops. */
  onClose(listener: () => void): void;
  /** Resolves once the vendor side of the tunnel is gone, and rejects when it could not be removed. */
  close(): Promise<void>;
}>;

export type InstalledApp = Readonly<{ id: string; name: string }>;

type Cancellable = Readonly<{ signal?: AbortSignal }>;

/** One TV as its vendor tooling reaches it. */
export type TvConnection = Readonly<{
  /** The one identity of the physical TV, the same for every alias that reaches it. */
  id: string;
  /** The name the lease asked for, which the daemon selects the device by. */
  name: string;
  /** Starts the app and opens a tunnel to its page target. */
  launch(appId: string, options: Cancellable & { relaunch: boolean }): Promise<PageTunnel>;
  close(appId: string, options?: Cancellable): Promise<void>;
  listApps(options?: Cancellable): Promise<InstalledApp[]>;
}>;

export type TvPlatform = Readonly<{
  provider: string;
  /** Vendor name in messages, e.g. `webOS`. */
  label: string;
  remoteKeys: RemoteKeys;
  /** Resolves the TV a lease asks for; throws DEVICE_NOT_FOUND when there is none. */
  connectTv(requested: string | undefined): Promise<TvConnection>;
}>;

export type TvSession = {
  readonly tv: TvConnection;
  readonly label: string;
  readonly logs: Map<string, PageLog>;
  appId?: string;
  released?: boolean;
  tunnel?: PageTunnel;
  /** Resolves to the first tunnel removal that failed since the last close or release. */
  teardown?: Promise<unknown>;
  page?: CdpSession;
};
