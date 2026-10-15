import { parseArgs } from 'node:util';
import { AppError } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';
import { resolveMetroServerUrl } from '../../metro/metro-reload-endpoints.ts';
import { readMetroSessionHints } from '../../metro/metro-session-hints.ts';
import {
  debuggerUrlOn,
  InspectorSession,
  listMetroInspectorTargets,
  selectReactNativeTarget,
  type MetroInspectorTarget,
} from './metro-inspector.ts';
import {
  REACT_DEVTOOLS_RUNTIME_GLOBAL,
  REACT_DEVTOOLS_RUNTIME_SOURCE,
  REACT_DEVTOOLS_RUNTIME_VERSION,
} from './react-devtools-runtime.ts';

export type ReactDevtoolsCommandOptions = {
  flags?: Partial<Pick<CliFlags, 'json'>>;
  stateDir: string;
  session: string;
};

const DEVTOOLS_OPTIONS = {
  limit: { type: 'string' },
  depth: { type: 'string' },
  exact: { type: 'boolean' },
  app: { type: 'string' },
  'metro-device': { type: 'string' },
  'metro-host': { type: 'string' },
  'metro-port': { type: 'string' },
  'bundle-url': { type: 'string' },
} as const;

export type DevtoolsOption = keyof typeof DEVTOOLS_OPTIONS;

/** Options that pick the app runtime: every command that talks to the app takes them. */
export const RUNTIME_OPTIONS: readonly DevtoolsOption[] = [
  'app',
  'metro-device',
  'metro-host',
  'metro-port',
  'bundle-url',
];

/** What one command form accepts, named as its usage reads in errors. */
export type CommandForm = {
  usage: string;
  positionals: number;
  options: readonly DevtoolsOption[];
};

export type RuntimeArgs = {
  app?: string;
  metroDevice?: string;
  metroHost?: string;
  metroPort?: string;
  bundleUrl?: string;
};

export type DevtoolsArgs = RuntimeArgs & {
  positionals: string[];
  limit?: number;
  depth?: number;
  exact: boolean;
};

const POSITIVE_INTEGER = /^[1-9]\d*$/;

function positiveInteger(option: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!POSITIVE_INTEGER.test(value)) {
    throw new AppError('INVALID_ARGS', `Invalid --${option}: ${value}. Use a positive integer.`);
  }
  return Number(value);
}

/** Parses `args` for the form its positionals select; any option that form does not read is refused. */
export function parseDevtoolsArgs(
  args: string[],
  formFor: (positionals: string[]) => CommandForm,
): DevtoolsArgs {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: DEVTOOLS_OPTIONS });
  } catch (error) {
    throw new AppError('INVALID_ARGS', error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const form = formFor(positionals);
  const unread = (Object.keys(values) as DevtoolsOption[]).find(
    (option) => !form.options.includes(option),
  );
  if (unread) {
    throw new AppError('INVALID_ARGS', `react-devtools ${form.usage} does not take --${unread}.`);
  }
  if (positionals.length > form.positionals) {
    throw new AppError(
      'INVALID_ARGS',
      `Unexpected argument for react-devtools ${form.usage}: ${positionals[form.positionals]}.`,
    );
  }
  return {
    positionals,
    limit: positiveInteger('limit', values.limit),
    depth: positiveInteger('depth', values.depth),
    exact: values.exact === true,
    app: values.app,
    metroDevice: values['metro-device'],
    metroHost: values['metro-host'],
    metroPort: values['metro-port'],
    bundleUrl: values['bundle-url'],
  };
}

/**
 * Explicit flags, then the session's Metro binding, then localhost:8081. A host or port flag on its
 * own overrides that part of the binding and keeps the rest. The debugger socket is only accepted
 * from the machine that runs Metro, so a device-facing URL such as a remote bridge's is never used.
 */
function resolveDevServerUrl(args: RuntimeArgs, options: ReactDevtoolsCommandOptions): URL {
  const complete =
    args.bundleUrl !== undefined || (args.metroHost !== undefined && args.metroPort !== undefined);
  const binding = complete
    ? undefined
    : readMetroSessionHints({ stateDir: options.stateDir, session: options.session });
  return resolveMetroServerUrl({
    metroHost: args.metroHost,
    metroPort: args.metroPort,
    bundleUrl: args.bundleUrl,
    runtime: binding ? { bundleUrl: binding.controlBaseUrl } : undefined,
  });
}

/** Connects to the app's JavaScript runtime, installs the DevTools runtime there, and runs `action`. */
export async function withAppRuntime<T>(
  args: RuntimeArgs,
  options: ReactDevtoolsCommandOptions,
  action: (session: InspectorSession, target: MetroInspectorTarget) => Promise<T>,
): Promise<T> {
  const serverUrl = resolveDevServerUrl(args, options);
  const target = selectReactNativeTarget(await listMetroInspectorTargets(serverUrl), {
    appId: args.app,
    device: args.metroDevice,
  });
  const session: InspectorSession = await InspectorSession.connect(
    debuggerUrlOn(serverUrl, target),
  );
  try {
    await session.evaluate(
      `(${REACT_DEVTOOLS_RUNTIME_SOURCE})(${JSON.stringify(REACT_DEVTOOLS_RUNTIME_VERSION)})`,
    );
    return await action(session, target);
  } finally {
    session.close();
  }
}

export async function callRuntime<T>(
  session: InspectorSession,
  method: string,
  argument?: unknown,
): Promise<T> {
  const call = `${REACT_DEVTOOLS_RUNTIME_GLOBAL}.${method}(${argument === undefined ? '' : JSON.stringify(argument)})`;
  const value = await session.evaluate(call);
  if (typeof value !== 'string') {
    throw new AppError(
      'COMMAND_FAILED',
      `The React DevTools runtime returned no result for ${method}.`,
    );
  }
  return JSON.parse(value) as T;
}

export type RuntimeFailure = { ok: false; reason: string; elapsedMs?: number; detail?: string };

const RUNTIME_FAILURES: Record<string, { message: string; hint: string }> = {
  'no-devtools-hook': {
    message: 'The app runtime has no React DevTools hook.',
    hint: 'Use a development build; release builds do not include React DevTools.',
  },
  'no-react-renderer': {
    message: 'React has not rendered in this app runtime yet.',
    hint: 'Wait for the app to finish loading its bundle, then retry.',
  },
  'no-devtools-backend': {
    message: 'This React Native version exposes no React DevTools backend to attach to.',
    hint: 'React Native 0.74 or newer is required.',
  },
  'backend-attach-failed': {
    message: 'The React DevTools backend did not attach to the app renderer.',
    hint: 'Reload the app and retry.',
  },
  'start-failed': {
    message: 'The React renderer refused to start profiling.',
    hint: 'Profile a development build; production renderers do not record render timings.',
  },
  'not-profiling': {
    message: 'No React profile is recording in this app runtime.',
    hint: 'Run react-devtools profile start first. A reload or app restart discards a recording.',
  },
  'collect-failed': {
    message: 'The React DevTools backend could not export the recorded profile.',
    hint: 'Run react-devtools profile start and stop again; reload the app if it keeps failing.',
  },
  'tree-unavailable': {
    message: 'Another React DevTools frontend owns the component tree of this app runtime.',
    hint: 'Close the connected React DevTools window, reload the app, and retry.',
  },
  'element-not-found': {
    message: 'No mounted component has that ref.',
    hint: 'Refs change when components remount or the app reloads; run react-devtools find or tree again.',
  },
  'inspect-failed': {
    message: 'The React DevTools backend could not inspect the component.',
    hint: 'Retry after the component renders again, or inspect its owner.',
  },
};

export function runtimeFailure(result: RuntimeFailure): AppError {
  const known = RUNTIME_FAILURES[result.reason];
  const message = known?.message ?? `React DevTools failed: ${result.reason}.`;
  return new AppError('COMMAND_FAILED', result.detail ? `${message} ${result.detail}` : message, {
    reason: result.reason,
    ...(known ? { hint: known.hint } : {}),
  });
}

export type Emit = (text: string, data: unknown) => void;

export function emitTo(options: ReactDevtoolsCommandOptions): Emit {
  const json = options.flags?.json === true;
  return (text, data) => {
    process.stdout.write(
      json ? `${JSON.stringify({ success: true, data }, null, 2)}\n` : `${text}\n`,
    );
  };
}
