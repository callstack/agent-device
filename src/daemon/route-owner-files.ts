import type { DaemonCommandRoute } from './request-handler-chain.ts';

/**
 * Development-only owner-file navigation claims for each daemon route (ADR 0008
 * follow-up, https://github.com/callstack/agent-device/issues/1178).
 *
 * Each route's runtime binding is its lazy `load` loader in
 * {@link DAEMON_ROUTE_HANDLERS}; the owner-file path is pure tooling metadata
 * that only `explain:command` consumes. Keeping it inline on the route object
 * shipped these strings in `dist/src/internal/daemon.js`, so — like the
 * per-command claims in `command-descriptor/owner-files.ts` — they live here in
 * a module the production import graph never reaches, and the bundler drops them.
 *
 * `satisfies Record<DaemonCommandRoute, string>` keeps the map complete: adding
 * or renaming a route in {@link DAEMON_ROUTE_HANDLERS} is a compile error until
 * this map matches. The `request-handler-chain` parity test additionally asserts
 * each path still points at the module that route's loader imports.
 */
const DAEMON_ROUTE_OWNER_FILES = {
  lease: 'src/daemon/handlers/lease.ts',
  session: 'src/daemon/handlers/session.ts',
  snapshot: 'src/daemon/handlers/snapshot.ts',
  reactNative: 'src/daemon/handlers/react-native.ts',
  recordTrace: 'src/daemon/handlers/record-trace.ts',
  find: 'src/daemon/handlers/find.ts',
  interaction: 'src/daemon/handlers/interaction.ts',
  generic: 'src/daemon/request-generic-dispatch.ts',
} as const satisfies Record<DaemonCommandRoute, string>;

export function getDaemonRouteOwnerFiles(): Record<DaemonCommandRoute, string> {
  return { ...DAEMON_ROUTE_OWNER_FILES };
}
