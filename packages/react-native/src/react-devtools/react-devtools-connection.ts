import { parseArgs } from 'node:util';
import { resolveSessionMetroServerUrl } from '../metro/metro-session-hints.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  REACT_DEVTOOLS_REASONS,
  type ReactDevtoolsFailureReason,
} from './react-devtools-reasons.ts';
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

/** Connects to the app's JavaScript runtime, installs the DevTools runtime there, and runs `action`. */
export async function withAppRuntime<T>(
  args: RuntimeArgs,
  options: ReactDevtoolsCommandOptions,
  action: (session: InspectorSession, target: MetroInspectorTarget) => Promise<T>,
): Promise<T> {
  const serverUrl = resolveSessionMetroServerUrl(options, args);
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

/**
 * The answer the injected runtime gave to a command. It states its own reason, so `reason` is
 * whatever text that runtime sent — this build's table rows only decide how it gets reported.
 */
export type RuntimeFailure = {
  ok: false;
  reason: string;
  detail?: string;
};

/** The message and recovery each runtime failure reason carries. */
const RUNTIME_FAILURES: Record<ReactDevtoolsFailureReason, { message: string; hint: string }> = {
  [REACT_DEVTOOLS_REASONS.noDevtoolsHook.reason]: {
    message: 'The app runtime has no React DevTools hook.',
    hint: 'Use a development build; release builds do not include React DevTools.',
  },
  [REACT_DEVTOOLS_REASONS.noReactRenderer.reason]: {
    message: 'React has not rendered in this app runtime yet.',
    hint: 'Wait for the app to finish loading its bundle, then retry.',
  },
  [REACT_DEVTOOLS_REASONS.noDevtoolsBackend.reason]: {
    message: 'This React Native version exposes no React DevTools backend to attach to.',
    hint: 'React Native 0.74 or newer is required.',
  },
  [REACT_DEVTOOLS_REASONS.backendAttachFailed.reason]: {
    message: 'The React DevTools backend did not attach to the app renderer.',
    hint: 'Reload the app and retry.',
  },
  [REACT_DEVTOOLS_REASONS.startFailed.reason]: {
    message: 'The React renderer refused to start profiling.',
    hint: 'Profile a development build; production renderers do not record render timings.',
  },
  [REACT_DEVTOOLS_REASONS.notProfiling.reason]: {
    message: 'No React profile is recording in this app runtime.',
    hint: 'Run react-devtools profile start first. A reload or app restart discards a recording.',
  },
  [REACT_DEVTOOLS_REASONS.collectFailed.reason]: {
    message: 'The React DevTools backend could not export the recorded profile.',
    hint: 'Run react-devtools profile start and stop again; reload the app if it keeps failing.',
  },
  [REACT_DEVTOOLS_REASONS.treeUnavailable.reason]: {
    message: 'Another React DevTools frontend owns the component tree of this app runtime.',
    hint: 'Close the connected React DevTools window, reload the app, and retry.',
  },
  [REACT_DEVTOOLS_REASONS.elementNotFound.reason]: {
    message: 'No mounted component has that ref.',
    hint: 'Refs change when components remount or the app reloads; run react-devtools find or tree again.',
  },
  [REACT_DEVTOOLS_REASONS.inspectFailed.reason]: {
    message: 'The React DevTools backend could not inspect the component.',
    hint: 'Retry after the component renders again, or inspect its owner.',
  },
};

/**
 * Whether an answer from the injected runtime is a declared reason. `RUNTIME_FAILURES` has one entry
 * per `REACT_DEVTOOLS_REASONS` row, so its own keys are exactly the declared spellings; the runtime
 * states its own reason, so it is untrusted text until this check passes.
 */
function isDeclaredRuntimeReason(reason: string): reason is ReactDevtoolsFailureReason {
  return Object.hasOwn(RUNTIME_FAILURES, reason);
}

/**
 * The error for one runtime answer. Every spelling the injected runtime can send has its own row
 * in `REACT_DEVTOOLS_REASONS` and its own wording here. A spelling this build does not declare is
 * never published as `details.reason`, whatever the runtime meant by it: the answer stays readable
 * through `details.runtimeReason` and the message, and a caller branching on a reason sees none.
 */
export function runtimeFailure(result: RuntimeFailure): AppError {
  const reason = result.reason;
  if (isDeclaredRuntimeReason(reason)) {
    const wording = RUNTIME_FAILURES[reason];
    return new AppError(
      'COMMAND_FAILED',
      result.detail ? `${wording.message} ${result.detail}` : wording.message,
      { reason, hint: wording.hint },
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `The React DevTools runtime reported an unknown failure (${result.reason}).${
      result.detail ? ` ${result.detail}` : ''
    }`,
    {
      runtimeReason: result.reason,
      hint: 'The injected runtime returned a reason this version does not declare, so this error reports none and the raw text is in details.runtimeReason. Reload the app, or update agent-device if it keeps happening.',
    },
  );
}
