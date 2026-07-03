export const PUBLIC_COMMANDS = {
  alert: 'alert',
  audio: 'audio',
  appState: 'appstate',
  appSwitcher: 'app-switcher',
  artifacts: 'artifacts',
  apps: 'apps',
  back: 'back',
  batch: 'batch',
  boot: 'boot',
  click: 'click',
  close: 'close',
  clipboard: 'clipboard',
  devices: 'devices',
  doctor: 'doctor',
  diff: 'diff',
  fill: 'fill',
  find: 'find',
  focus: 'focus',
  gesture: 'gesture',
  get: 'get',
  home: 'home',
  install: 'install',
  installFromSource: 'install-from-source',
  is: 'is',
  keyboard: 'keyboard',
  logs: 'logs',
  longPress: 'longpress',
  network: 'network',
  open: 'open',
  perf: 'perf',
  prepare: 'prepare',
  press: 'press',
  push: 'push',
  record: 'record',
  reactNative: 'react-native',
  reinstall: 'reinstall',
  replay: 'replay',
  rotate: 'rotate',
  scroll: 'scroll',
  screenshot: 'screenshot',
  settings: 'settings',
  shutdown: 'shutdown',
  snapshot: 'snapshot',
  swipe: 'swipe',
  test: 'test',
  trace: 'trace',
  triggerAppEvent: 'trigger-app-event',
  type: 'type',
  viewport: 'viewport',
  wait: 'wait',
} as const;

export const INTERNAL_COMMANDS = {
  installSource: 'install_source',
  leaseAllocate: 'lease_allocate',
  leaseHeartbeat: 'lease_heartbeat',
  leaseRelease: 'lease_release',
  releaseMaterializedPaths: 'release_materialized_paths',
  runtime: 'runtime',
  sessionList: 'session_list',
} as const;

const LOCAL_CLI_COMMANDS = {
  cdp: 'cdp',
  auth: 'auth',
  connect: 'connect',
  connection: 'connection',
  debug: 'debug',
  disconnect: 'disconnect',
  mcp: 'mcp',
  metro: 'metro',
  proxy: 'proxy',
  reactDevtools: 'react-devtools',
  session: 'session',
  web: 'web',
} as const;

export const SPECIAL_CLI_COMMANDS = {
  help: 'help',
} as const;

export const GESTURE_KINDS = ['pan', 'fling', 'swipe', 'pinch', 'rotate', 'transform'] as const;
export type GestureKind = (typeof GESTURE_KINDS)[number];
export const GESTURE_SUBCOMMAND_ERROR = `gesture requires one of: ${GESTURE_KINDS.join(', ')}`;

export type PublicCommandName = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];
export type InternalCommandName = (typeof INTERNAL_COMMANDS)[keyof typeof INTERNAL_COMMANDS];
export type LocalCliCommandName = (typeof LOCAL_CLI_COMMANDS)[keyof typeof LOCAL_CLI_COMMANDS];
export type SpecialCliCommandName =
  (typeof SPECIAL_CLI_COMMANDS)[keyof typeof SPECIAL_CLI_COMMANDS];
export type CliCommandName = PublicCommandName | LocalCliCommandName;
export type KnownCliCommandName = CliCommandName | InternalCommandName | SpecialCliCommandName;
export type ClientBackedCliCommandName =
  | PublicCommandName
  | typeof LOCAL_CLI_COMMANDS.debug
  | typeof LOCAL_CLI_COMMANDS.metro
  | typeof LOCAL_CLI_COMMANDS.session;

const MCP_UNEXPOSED_CLI_COMMANDS = commandSet(
  LOCAL_CLI_COMMANDS.auth,
  LOCAL_CLI_COMMANDS.cdp,
  LOCAL_CLI_COMMANDS.connect,
  LOCAL_CLI_COMMANDS.connection,
  LOCAL_CLI_COMMANDS.disconnect,
  LOCAL_CLI_COMMANDS.mcp,
  LOCAL_CLI_COMMANDS.proxy,
  LOCAL_CLI_COMMANDS.reactDevtools,
  LOCAL_CLI_COMMANDS.web,
  PUBLIC_COMMANDS.prepare,
);

const CAPABILITY_EXEMPT_CLI_COMMANDS = commandSet(
  LOCAL_CLI_COMMANDS.auth,
  LOCAL_CLI_COMMANDS.cdp,
  LOCAL_CLI_COMMANDS.connect,
  LOCAL_CLI_COMMANDS.connection,
  LOCAL_CLI_COMMANDS.debug,
  LOCAL_CLI_COMMANDS.disconnect,
  LOCAL_CLI_COMMANDS.mcp,
  LOCAL_CLI_COMMANDS.metro,
  LOCAL_CLI_COMMANDS.proxy,
  LOCAL_CLI_COMMANDS.reactDevtools,
  LOCAL_CLI_COMMANDS.session,
  LOCAL_CLI_COMMANDS.web,
  PUBLIC_COMMANDS.artifacts,
  PUBLIC_COMMANDS.appState,
  PUBLIC_COMMANDS.prepare,
  PUBLIC_COMMANDS.batch,
  PUBLIC_COMMANDS.devices,
  PUBLIC_COMMANDS.doctor,
  PUBLIC_COMMANDS.gesture,
  PUBLIC_COMMANDS.replay,
  PUBLIC_COMMANDS.test,
  PUBLIC_COMMANDS.trace,
);

function commandSet(...commands: readonly string[]): ReadonlySet<string> {
  return new Set(commands);
}

export function listCliCommandNames(): CliCommandName[] {
  return [...Object.values(PUBLIC_COMMANDS), ...Object.values(LOCAL_CLI_COMMANDS)].sort();
}

export function isKnownCliCommandName(command: string): command is KnownCliCommandName {
  if ((Object.values(SPECIAL_CLI_COMMANDS) as readonly string[]).includes(command)) return true;
  if ((Object.values(INTERNAL_COMMANDS) as readonly string[]).includes(command)) return true;
  return (listCliCommandNames() as readonly string[]).includes(command);
}

export function isClientBackedCliCommandName(
  command: string,
): command is ClientBackedCliCommandName {
  return (
    Object.values(PUBLIC_COMMANDS).includes(command as PublicCommandName) ||
    command === LOCAL_CLI_COMMANDS.debug ||
    command === LOCAL_CLI_COMMANDS.metro ||
    command === LOCAL_CLI_COMMANDS.session
  );
}

export function listMcpExposedCommandNames(): CliCommandName[] {
  return listCliCommandNames().filter((command) => !MCP_UNEXPOSED_CLI_COMMANDS.has(command));
}

export function listCapabilityCheckedCommandNames(): CliCommandName[] {
  return listCliCommandNames().filter((command) => !CAPABILITY_EXEMPT_CLI_COMMANDS.has(command));
}
