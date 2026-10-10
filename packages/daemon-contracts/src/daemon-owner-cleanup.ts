/** Identity of the daemon process whose retained host resources may be reconciled. */
export type DaemonOwnerIdentity = Readonly<{
  pid: number;
  startTime?: string | null;
}>;

/** Host-scoped cleanup used after a daemon has stopped and can no longer clean itself. */
export type DaemonOwnerCleanup = Readonly<{
  cleanup(owner: DaemonOwnerIdentity): Promise<void>;
}>;
