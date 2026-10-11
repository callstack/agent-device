/**
 * The provider credentials a daemon started with, and the state dir that names that daemon.
 *
 * A `lease_allocate` request carries the caller's own fingerprint so a lease can be fenced to one
 * credential set (#2559): the daemon compares the request's value against the fingerprint it
 * computed from its own startup environment, and both sides read this one declaration — the
 * daemon's implementation stays in the process root (`src/provider-credential-fingerprint.ts`),
 * and the wire-comparing client reads only this vocabulary.
 */
export type DaemonProviderCredentials = Readonly<{
  /** Undefined when the daemon's environment holds none of the credentials such a lease reads. */
  fingerprint(provider: string, leaseBackend?: string): string | undefined;
  stateDir: string;
}>;
