import type { DaemonResponse, sendToDaemon } from '../daemon/client/daemon-client.ts';
import { INTERNAL_COMMANDS } from '../command-catalog.ts';
import type {
  DescriptorCliCommandName,
  DescriptorDaemonRouteCommandName,
} from '../core/command-descriptor/registry.ts';

type CliDaemonTransport = typeof sendToDaemon;
type CliDaemonRequest = Parameters<CliDaemonTransport>[0];
type CliDaemonTransportOptions = Parameters<CliDaemonTransport>[1];

/**
 * The CLI's injected daemon dispatches (ADR 0019 §6).
 *
 * Ordinary commands reach the daemon through the client transport, carrying their own
 * name. A few CLI routes additionally inject a *different* command into their flow —
 * `react-devtools start` on a Limrun Android instance sets up its port reverse by
 * dispatching internal `runtime`. That injection is the case where a descriptor's own
 * module is platform-free while its route reaches platform behavior, so the pairs must
 * be enumerable to keep the migration denominator honest.
 *
 * This table is that enumeration, and {@link sendInjectedDaemonRequest} is the only way
 * to perform one: the route and command are typed parameters checked against this table,
 * so an undeclared pair is a compile error rather than something a scanner must find.
 */
export const CLI_INJECTED_DAEMON_DISPATCHES = {
  'react-devtools': [INTERNAL_COMMANDS.runtime],
} as const satisfies Partial<
  Record<DescriptorCliCommandName, readonly DescriptorDaemonRouteCommandName[]>
>;

export type CliInjectedRoute = keyof typeof CLI_INJECTED_DAEMON_DISPATCHES;

type InjectedCommandFor<Route extends CliInjectedRoute> =
  (typeof CLI_INJECTED_DAEMON_DISPATCHES)[Route][number];

/**
 * The single construction point for a CLI-injected daemon request. `command` comes from
 * the declared pair rather than from the caller's object literal, so the dispatched
 * command is known by type at every call site.
 */
export async function sendInjectedDaemonRequest<Route extends CliInjectedRoute>(params: {
  route: Route;
  command: InjectedCommandFor<Route>;
  request: Omit<CliDaemonRequest, 'command'>;
  transport: CliDaemonTransport;
  transportOptions?: CliDaemonTransportOptions;
}): Promise<DaemonResponse> {
  const { command, request, transport, transportOptions } = params;
  return await transport({ ...request, command }, transportOptions);
}
