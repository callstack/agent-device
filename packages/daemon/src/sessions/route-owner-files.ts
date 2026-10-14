import type { DaemonCommandRoute } from './request-handler-chain.ts';

/**
 * Development-only owner-file navigation claims for each daemon route (ADR 0008
 * follow-up, https://github.com/callstack/agent-device/issues/1178).
 *
 * Each route's runtime binding is its lazy `load` loader in
 * {@link DAEMON_ROUTE_HANDLERS}; the owner-file path is pure tooling metadata
 * that only `explain:command` consumes. Keeping it inline on the route object
 * shipped these strings in `dist/src/internal/daemon.js`, so — like the
 * per-command claims in `@agent-device/command-registry/owner-files` — they live here in
 * a module the production import graph never reaches, and the bundler drops them.
 *
 * `satisfies Record<DaemonCommandRoute, string>` keeps the map complete: adding
 * or renaming a route in {@link DAEMON_ROUTE_HANDLERS} is a compile error until
 * this map matches. The `request-handler-chain` parity test additionally asserts
 * each path still points at the module that route's loader imports.
 */
const DAEMON_ROUTE_OWNER_FILES = {
  humanControl: 'packages/daemon/src/sessions/handlers/human-control.ts',
  lease: 'packages/daemon/src/sessions/handlers/lease.ts',
  session: 'packages/daemon/src/sessions/handlers/session.ts',
  snapshot: 'packages/daemon/src/sessions/handlers/snapshot.ts',
  reactNative: 'packages/daemon/src/execution/handlers/react-native.ts',
  recordTrace: 'packages/daemon/src/sessions/handlers/record-trace.ts',
  find: 'packages/daemon/src/execution/interaction/index.ts',
  interaction: 'packages/daemon/src/execution/interaction/index.ts',
  generic: 'packages/daemon/src/execution/request-generic-dispatch.ts',
} as const satisfies Record<DaemonCommandRoute, string>;

export function getDaemonRouteOwnerFiles(): Record<DaemonCommandRoute, string> {
  return { ...DAEMON_ROUTE_OWNER_FILES };
}
