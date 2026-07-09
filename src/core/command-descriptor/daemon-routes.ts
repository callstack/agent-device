export const DAEMON_COMMAND_ROUTES = {
  lease: { ownerFile: 'src/daemon/handlers/lease.ts' },
  session: { ownerFile: 'src/daemon/handlers/session.ts' },
  snapshot: { ownerFile: 'src/daemon/handlers/snapshot.ts' },
  reactNative: { ownerFile: 'src/daemon/handlers/react-native.ts' },
  recordTrace: { ownerFile: 'src/daemon/handlers/record-trace.ts' },
  find: { ownerFile: 'src/daemon/handlers/find.ts' },
  interaction: { ownerFile: 'src/daemon/handlers/interaction.ts' },
  generic: { ownerFile: 'src/daemon/request-generic-dispatch.ts' },
} as const;

export type DaemonCommandRoute = keyof typeof DAEMON_COMMAND_ROUTES;
