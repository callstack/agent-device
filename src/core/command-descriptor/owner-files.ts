import type { Command } from './registry.ts';

/**
 * Development-only owner-file navigation claims for every command (ADR 0008
 * follow-up, https://github.com/callstack/agent-device/issues/1178).
 *
 * These paths point a reader at the module that owns each command's surface so
 * `explain:command` can render "where does this live". They are pure tooling
 * metadata: nothing in the daemon/CLI runtime reads them, so they were removed
 * from the production {@link CommandDescriptor} objects (and therefore from the
 * emitted bundles) and colocated here instead.
 *
 * This is a typed projection of the descriptor registry, NOT a parallel command
 * registry: the key space is the descriptor-derived {@link Command} union, so
 * `satisfies Record<Command, ...>` makes a missing or misspelled command a
 * compile error and forbids owner claims for commands that do not exist. Add or
 * remove a command in {@link commandDescriptors} and the typechecker forces the
 * matching edit here — the same completeness guarantee the colocated field gave,
 * without shipping the strings.
 *
 * Only `command-explain.ts` and its tests import this module. Because the
 * production import graph never reaches it, the bundler drops it entirely.
 */
export const COMMAND_OWNER_FILES = {
  // -- lease --
  lease_allocate: ['src/daemon/handlers/lease.ts'],
  lease_heartbeat: ['src/daemon/handlers/lease.ts'],
  lease_release: ['src/daemon/handlers/lease.ts'],
  artifacts: ['src/commands/management/artifacts.ts'],
  // -- session / inventory --
  session_list: ['src/daemon/handlers/session-inventory.ts'],
  devices: ['src/commands/management/device.ts'],
  capabilities: ['src/commands/management/device.ts'],
  doctor: ['src/commands/management/doctor.ts'],
  apps: ['src/commands/management/app.ts'],
  boot: ['src/commands/management/device.ts'],
  shutdown: ['src/commands/management/device.ts'],
  appstate: ['src/commands/system/index.ts'],
  perf: ['src/commands/perf/index.ts'],
  logs: ['src/commands/observability/index.ts'],
  events: ['src/commands/observability/index.ts'],
  network: ['src/commands/observability/index.ts'],
  audio: ['src/commands/observability/index.ts'],
  replay: ['src/commands/replay/index.ts'],
  test: ['src/commands/replay/index.ts'],
  runtime: ['src/daemon/handlers/session-runtime-command.ts'],
  clipboard: ['src/commands/system/index.ts'],
  keyboard: ['src/commands/system/index.ts'],
  install: ['src/commands/management/install.ts'],
  reinstall: ['src/commands/management/install.ts'],
  install_source: ['src/daemon/handlers/install-source.ts'],
  release_materialized_paths: ['src/daemon/handlers/install-source.ts'],
  push: ['src/commands/management/push.ts'],
  'trigger-app-event': ['src/commands/management/push.ts'],
  open: ['src/commands/management/app.ts'],
  prepare: ['src/commands/management/prepare.ts'],
  batch: ['src/commands/batch/index.ts'],
  close: ['src/commands/management/app.ts'],
  // -- capture --
  snapshot: ['src/commands/capture/snapshot.ts'],
  diff: ['src/commands/capture/diff.ts'],
  wait: ['src/commands/capture/wait.ts'],
  alert: ['src/commands/capture/alert.ts'],
  settings: ['src/commands/capture/settings.ts'],
  'react-native': ['src/commands/react-native/index.ts'],
  record: ['src/commands/recording/index.ts'],
  trace: ['src/commands/recording/index.ts'],
  // -- interaction --
  find: ['src/commands/interaction/index.ts'],
  click: ['src/commands/interaction/index.ts'],
  fill: ['src/commands/interaction/index.ts'],
  longpress: ['src/commands/interaction/index.ts'],
  press: ['src/commands/interaction/index.ts'],
  type: ['src/commands/interaction/index.ts'],
  get: ['src/commands/interaction/index.ts'],
  read: ['src/daemon/handlers/interaction.ts'],
  is: ['src/commands/interaction/index.ts'],
  back: ['src/commands/system/index.ts'],
  gesture: ['src/commands/interaction/index.ts'],
  home: ['src/commands/system/index.ts'],
  'tv-remote': ['src/commands/system/index.ts'],
  rotate: ['src/commands/system/index.ts'],
  scroll: ['src/commands/interaction/index.ts'],
  swipe: ['src/commands/interaction/index.ts'],
  'swipe-preset': ['src/core/dispatch.ts'],
  pinch: ['src/core/dispatch.ts'],
  focus: ['src/commands/interaction/index.ts'],
  screenshot: ['src/commands/capture/screenshot.ts'],
  viewport: ['src/commands/management/viewport.ts'],
  pan: ['src/core/dispatch.ts'],
  fling: ['src/core/dispatch.ts'],
  'rotate-gesture': ['src/core/dispatch.ts'],
  'transform-gesture': ['src/core/dispatch.ts'],
  'app-switcher': ['src/commands/system/index.ts'],
  'install-from-source': ['src/commands/management/install.ts'],
  debug: ['src/commands/debugging/index.ts'],
  metro: ['src/commands/metro/index.ts'],
  session: ['src/commands/management/session.ts'],
  // -- schema-only local CLI --
  cdp: ['src/cli/commands/agent-cdp.ts'],
  auth: ['src/cli/commands/auth.ts'],
  connect: ['src/cli/commands/connection.ts'],
  connection: ['src/cli/commands/connection.ts'],
  disconnect: ['src/cli/commands/connection.ts'],
  mcp: ['src/bin.ts'],
  proxy: ['src/cli/commands/proxy.ts'],
  'react-devtools': ['src/cli/commands/react-devtools.ts'],
  web: ['src/cli/commands/web.ts'],
} as const satisfies Record<Command, readonly [string, ...string[]]>;

/** The owner-file claims for one command (development-only navigation metadata). */
export function ownerFilesForCommand(command: Command): readonly [string, ...string[]] {
  return COMMAND_OWNER_FILES[command];
}
