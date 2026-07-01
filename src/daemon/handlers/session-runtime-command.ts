import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { publicPlatformString } from '../../kernel/device.ts';
import { SessionStore } from '../session-store.ts';
import { clearRuntimeHintsFromApp, hasRuntimeTransportHints } from '../runtime-hints.ts';
import { errorResponse } from './response.ts';
import {
  buildRuntimeHints,
  countConfiguredRuntimeHints,
  mergeRuntimeHints,
  toRuntimePlatform,
} from './session-runtime.ts';
import {
  configureProviderPortReverse,
  type ProviderPortReverseOptions,
  removeProviderPortReverse,
} from '../../provider-device-runtime.ts';

type RuntimeAction = 'set' | 'show' | 'clear';
type PortReverseAction = 'port-reverse' | 'port-reverse-remove';
type PortReverseParseResult =
  | { ok: true; options: ProviderPortReverseOptions }
  | { ok: false; response: DaemonResponse };
type PortReverseRequiredFields =
  | { ok: true; leaseId: string; provider: string }
  | { ok: false; response: DaemonResponse };
type PortReversePorts =
  | { ok: true; devicePort: number; hostPort: number }
  | { ok: false; response: DaemonResponse };

export async function handleRuntimeCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const action = (req.positionals?.[0] ?? 'show').toLowerCase();
  if (isPortReverseAction(action)) {
    return await handlePortReverseCommand(req, action);
  }
  if (!isRuntimeAction(action)) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime requires set, show, clear, port-reverse, or port-reverse-remove',
    );
  }
  const session = sessionStore.get(sessionName);
  const current = sessionStore.getRuntimeHints(sessionName);
  if (action === 'clear') {
    return await clearRuntimeCommand(sessionName, sessionStore, session, current);
  }
  if (action === 'show') {
    return showRuntimeCommand(sessionName, current);
  }

  return setRuntimeCommand({ req, sessionName, sessionStore, session, current });
}

function isRuntimeAction(action: string): action is RuntimeAction {
  return action === 'set' || action === 'show' || action === 'clear';
}

function isPortReverseAction(action: string): action is PortReverseAction {
  return action === 'port-reverse' || action === 'port-reverse-remove';
}

async function clearRuntimeCommand(
  sessionName: string,
  sessionStore: SessionStore,
  session: ReturnType<SessionStore['get']>,
  current: ReturnType<SessionStore['getRuntimeHints']>,
): Promise<DaemonResponse> {
  if (hasRuntimeTransportHints(current) && session?.appBundleId) {
    await clearRuntimeHintsFromApp({
      device: session.device,
      appId: session.appBundleId,
    });
  }
  const cleared = sessionStore.clearRuntimeHints(sessionName);
  return { ok: true, data: { session: sessionName, cleared } };
}

function showRuntimeCommand(
  sessionName: string,
  current: ReturnType<SessionStore['getRuntimeHints']>,
): DaemonResponse {
  return {
    ok: true,
    data: {
      session: sessionName,
      configured: Boolean(current),
      runtime: current,
    },
  };
}

function sessionLeafPlatform(
  session: ReturnType<SessionStore['get']>,
): ReturnType<typeof publicPlatformString> | undefined {
  return session ? publicPlatformString(session.device) : undefined;
}

function setRuntimeCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  session: ReturnType<SessionStore['get']>;
  current: ReturnType<SessionStore['getRuntimeHints']>;
}): DaemonResponse {
  const { req, sessionName, sessionStore, session, current } = params;
  // approach (b): resolve the session's PUBLIC leaf platform (ios/macos), never the
  // internal `apple`, so the legacy `--platform ios` selector still matches.
  const sessionLeaf = sessionLeafPlatform(session);
  const platform = toRuntimePlatform(req.flags?.platform ?? current?.platform ?? sessionLeaf);
  if (!platform) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime set only supports iOS and Android sessions. Pass --platform ios|android or open an iOS/Android session first.',
    );
  }
  if (sessionLeaf !== undefined && sessionLeaf !== platform) {
    return errorResponse(
      'INVALID_ARGS',
      `runtime set targets ${platform}, but session "${sessionName}" is already bound to ${sessionLeaf}.`,
    );
  }
  const nextRuntime = mergeRuntimeHints(current, buildRuntimeHints(req.flags, platform));
  if (countConfiguredRuntimeHints(nextRuntime) === 0) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime set requires at least one hint such as --metro-host, --metro-port, --bundle-url, or --launch-url.',
    );
  }
  sessionStore.setRuntimeHints(sessionName, nextRuntime);
  return {
    ok: true,
    data: {
      session: sessionName,
      configured: true,
      runtime: nextRuntime,
    },
  };
}

async function handlePortReverseCommand(
  req: DaemonRequest,
  action: PortReverseAction,
): Promise<DaemonResponse> {
  const parsed = readPortReverseOptions(req);
  if (!parsed.ok) return parsed.response;
  const result = await executePortReverseAction(action, parsed.options);
  if (!result) {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'No active provider device runtime supports port reverse for this lease.',
    );
  }
  return {
    ok: true,
    data: {
      action,
      ...result,
    },
  };
}

function readPortReverseOptions(req: DaemonRequest): PortReverseParseResult {
  const required = readRequiredPortReverseFields(req);
  if (!required.ok) return required;
  const ports = readPortReversePorts(req);
  if (!ports.ok) return ports;
  const name = req.flags?.portReverseName?.trim() || 'runtime';
  return {
    ok: true,
    options: {
      leaseId: required.leaseId,
      provider: required.provider,
      devicePort: ports.devicePort,
      hostPort: ports.hostPort,
      name,
    },
  };
}

function readRequiredPortReverseFields(req: DaemonRequest): PortReverseRequiredFields {
  const leaseId = req.flags?.leaseId;
  const provider = req.flags?.leaseProvider;
  if (!leaseId) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'runtime port-reverse requires a resolved remote lease.',
      ),
    };
  }
  if (!provider) {
    return {
      ok: false,
      response: errorResponse('INVALID_ARGS', 'runtime port-reverse requires a lease provider.'),
    };
  }
  return { ok: true, leaseId, provider };
}

function readPortReversePorts(req: DaemonRequest): PortReversePorts {
  const devicePort = readTcpPort(req.flags?.devicePort);
  const hostPort = readTcpPort(req.flags?.hostPort ?? req.flags?.devicePort);
  if (!devicePort || !hostPort) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'runtime port-reverse requires numeric devicePort and hostPort values from 1 to 65535.',
      ),
    };
  }
  return { ok: true, devicePort, hostPort };
}

async function executePortReverseAction(
  action: PortReverseAction,
  options: ProviderPortReverseOptions,
): Promise<Record<string, unknown> | undefined> {
  if (action === 'port-reverse') {
    return await configureProviderPortReverse(options);
  }
  return await removeProviderPortReverse(options);
}

function readTcpPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return undefined;
  }
  return value;
}
