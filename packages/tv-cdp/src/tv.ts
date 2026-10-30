import type { CdpSession, CdpTarget } from './cdp.ts';
import type { RemoteKeys } from './keys.ts';
import type { PageLog } from './page-log.ts';

export type PageTunnel = Readonly<{
  target: CdpTarget;
  /** Runs when the tunnel ends, including when the TV sleeps or the network drops. */
  onClose(listener: () => void): void;
  close(): void;
}>;

export type InstalledApp = Readonly<{ id: string; name: string }>;

/** One TV as its vendor tooling reaches it. */
export type TvConnection = Readonly<{
  name: string;
  /** Starts the app and opens a tunnel to its page target. */
  launch(appId: string, options: { relaunch: boolean }): Promise<PageTunnel>;
  close(appId: string): Promise<void>;
  listApps(): Promise<InstalledApp[]>;
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
  page?: CdpSession;
};
