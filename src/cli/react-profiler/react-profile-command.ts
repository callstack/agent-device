import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AppError } from '@agent-device/kernel/errors';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import type { CliFlags } from '@agent-device/contracts/command';
import { resolveMetroServerUrl } from '../../metro/metro-reload-endpoints.ts';
import { readMetroSessionHints } from '../../metro/metro-session-hints.ts';
import { isRemoteBridgeBackend } from '../commands/remote-bridge.ts';
import {
  InspectorSession,
  listMetroInspectorTargets,
  selectReactNativeTarget,
  targetAppId,
  type MetroInspectorTarget,
} from './metro-inspector.ts';
import {
  REACT_PROFILER_RUNTIME_GLOBAL,
  REACT_PROFILER_RUNTIME_SOURCE,
  REACT_PROFILER_RUNTIME_VERSION,
} from './react-profiler-runtime.ts';
import { analyzeReactProfile, type ReactProfileAnalysis } from './react-profile-analysis.ts';
import {
  selectPropKindRequests,
  type CommitProfile,
  type ComponentProfile,
  type PropKindsById,
  type RawReactProfile,
} from './react-profile-renders.ts';
import {
  componentsByRenders,
  DEFAULT_FINDING_LIMIT,
  findComponent,
  formatSeconds,
  formatCommit,
  formatComponentReport,
  formatProfileSummary,
  formatRerenders,
  formatSlowComponents,
  formatTimeline,
  timelineCommits,
} from './react-profile-format.ts';

const REACT_PROFILE_SUBCOMMANDS = [
  'start',
  'stop',
  'status',
  'slow',
  'rerenders',
  'report',
  'timeline',
  'commit',
] as const;

type ReactProfileSubcommand = (typeof REACT_PROFILE_SUBCOMMANDS)[number];

/** Debugger connection to one app runtime; `InspectorSession` in production. */
type AppRuntimeChannel = Pick<InspectorSession, 'evaluate' | 'close'>;

export type ReactProfileCommandOptions = {
  flags?: Partial<Pick<CliFlags, 'json' | 'leaseBackend' | 'metroPublicBaseUrl'>>;
  stateDir: string;
  session: string;
  write?: (text: string) => void;
  fetchImpl?: typeof fetch;
  connect?: (webSocketDebuggerUrl: string) => Promise<AppRuntimeChannel>;
};

type ProfileArgs = {
  subcommand: ReactProfileSubcommand;
  target?: string;
  limit?: number;
  app?: string;
  metroHost?: string;
  metroPort?: string;
  bundleUrl?: string;
  sort?: 'timeline' | 'duration';
};

/** Analysis plus the runtime it came from, as `profile stop` saves it for the drill-down views. */
type SavedReactProfile = {
  savedAt: string;
  appId?: string;
  deviceName?: string;
  analysis: ReactProfileAnalysis;
};

type RuntimeFailure = { ok: false; reason: string; elapsedMs?: number };
type StartResult = { ok: true; attach: string } | RuntimeFailure;
type StopResult = ({ ok: true } & RawReactProfile) | RuntimeFailure;
type StatusResult = { profiling: boolean; elapsedMs: number | null };

function isReactProfileSubcommand(value: string | undefined): value is ReactProfileSubcommand {
  return REACT_PROFILE_SUBCOMMANDS.includes(value as ReactProfileSubcommand);
}

const PROFILE_OPTIONS = {
  limit: { type: 'string' },
  app: { type: 'string' },
  'metro-host': { type: 'string' },
  'metro-port': { type: 'string' },
  'bundle-url': { type: 'string' },
  sort: { type: 'string' },
} as const;

function parseProfileOptions(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options: PROFILE_OPTIONS });
  } catch (error) {
    throw new AppError('INVALID_ARGS', error instanceof Error ? error.message : String(error));
  }
}

function parseProfileArgs(args: string[]): ProfileArgs {
  const [subcommand, ...rest] = args;
  if (!isReactProfileSubcommand(subcommand)) {
    throw new AppError(
      'INVALID_ARGS',
      `Unknown react-devtools profile command: ${subcommand ?? '(none)'}.`,
      { hint: `Use one of: ${REACT_PROFILE_SUBCOMMANDS.join(', ')}.` },
    );
  }
  const parsed = parseProfileOptions(rest);
  const { values, positionals } = parsed;
  const limit = values.limit === undefined ? undefined : Number.parseInt(values.limit, 10);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new AppError('INVALID_ARGS', `Invalid --limit: ${values.limit}. Use a positive integer.`);
  }
  if (values.sort !== undefined && values.sort !== 'timeline' && values.sort !== 'duration') {
    throw new AppError('INVALID_ARGS', `Invalid --sort: ${values.sort}. Use timeline or duration.`);
  }
  return {
    subcommand,
    target: positionals[0],
    limit,
    app: values.app,
    metroHost: values['metro-host'],
    metroPort: values['metro-port'],
    bundleUrl: values['bundle-url'],
    sort: values.sort as ProfileArgs['sort'],
  };
}

/** Explicit flags, then a remote bridge's public dev-server URL, then the session's Metro binding. */
function resolveDevServerUrl(args: ProfileArgs, options: ReactProfileCommandOptions): URL {
  const publicBaseUrl = options.flags?.metroPublicBaseUrl?.trim();
  const explicit =
    args.metroHost !== undefined || args.metroPort !== undefined || args.bundleUrl !== undefined;
  if (!explicit && publicBaseUrl && isRemoteBridgeBackend(options.flags?.leaseBackend)) {
    return resolveMetroServerUrl({ bundleUrl: publicBaseUrl });
  }
  const binding = explicit
    ? undefined
    : readMetroSessionHints({ stateDir: options.stateDir, session: options.session });
  return resolveMetroServerUrl({
    metroHost: args.metroHost,
    metroPort: args.metroPort,
    bundleUrl: args.bundleUrl,
    runtime: binding ? { bundleUrl: binding.controlBaseUrl } : undefined,
  });
}

async function withAppRuntime<T>(
  args: ProfileArgs,
  options: ReactProfileCommandOptions,
  action: (session: AppRuntimeChannel, target: MetroInspectorTarget) => Promise<T>,
): Promise<T> {
  const serverUrl = resolveDevServerUrl(args, options);
  const target = selectReactNativeTarget(
    await listMetroInspectorTargets(serverUrl, options.fetchImpl),
    args.app,
  );
  const connect = options.connect ?? ((url: string) => InspectorSession.connect(url));
  const session = await connect(target.webSocketDebuggerUrl);
  try {
    await session.evaluate(
      `(${REACT_PROFILER_RUNTIME_SOURCE})(${JSON.stringify(REACT_PROFILER_RUNTIME_VERSION)})`,
    );
    return await action(session, target);
  } finally {
    session.close();
  }
}

async function callRuntime<T>(
  session: AppRuntimeChannel,
  method: string,
  argument?: unknown,
): Promise<T> {
  const call = `${REACT_PROFILER_RUNTIME_GLOBAL}.${method}(${argument === undefined ? '' : JSON.stringify(argument)})`;
  const value = await session.evaluate(call);
  if (typeof value !== 'string') {
    throw new AppError('COMMAND_FAILED', `The profiler runtime returned no result for ${method}.`);
  }
  return JSON.parse(value) as T;
}

const RUNTIME_FAILURES: Record<string, { message: string; hint: string }> = {
  'no-devtools-hook': {
    message: 'The app runtime has no React DevTools hook.',
    hint: 'Profile a development build; release builds do not include React DevTools.',
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
};

function runtimeFailure(result: RuntimeFailure): AppError {
  const known = RUNTIME_FAILURES[result.reason];
  return new AppError(
    'COMMAND_FAILED',
    known?.message ?? `React profiling failed: ${result.reason}.`,
    {
      reason: result.reason,
      ...(known ? { hint: known.hint } : {}),
    },
  );
}

function savedProfilePath(options: ReactProfileCommandOptions): string {
  return path.join(options.stateDir, 'react-profiles', `${safeSessionName(options.session)}.json`);
}

function writeSavedProfile(
  options: ReactProfileCommandOptions,
  profile: SavedReactProfile,
): string {
  const filePath = savedProfilePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(profile)}\n`, 'utf8');
  return filePath;
}

function readSavedProfile(options: ReactProfileCommandOptions): SavedReactProfile {
  let raw: string;
  try {
    raw = fs.readFileSync(savedProfilePath(options), 'utf8');
  } catch {
    throw new AppError('COMMAND_FAILED', `No React profile saved for session ${options.session}.`, {
      hint: 'Run react-devtools profile start, perform the interaction, then react-devtools profile stop.',
    });
  }
  let saved: SavedReactProfile | undefined;
  try {
    saved = JSON.parse(raw) as SavedReactProfile;
  } catch {
    saved = undefined;
  }
  if (saved?.analysis?.version !== 1) {
    throw new AppError('COMMAND_FAILED', 'The saved React profile has an unsupported format.', {
      hint: 'Record a new profile with react-devtools profile start and stop.',
    });
  }
  return saved;
}

const elapsed = (elapsedMs: number) => formatSeconds(Math.max(0, elapsedMs));

async function startProfile(
  args: ProfileArgs,
  options: ReactProfileCommandOptions,
): Promise<{ app: string; message: string }> {
  return await withAppRuntime(args, options, async (session, target) => {
    const result = await callRuntime<StartResult>(session, 'start');
    const app = targetAppId(target);
    if (!result.ok && result.reason === 'already-profiling') {
      return {
        app,
        alreadyProfiling: true,
        message: `Already profiling ${app} for ${elapsed(result.elapsedMs ?? 0)}; run react-devtools profile stop to read it.`,
      };
    }
    if (!result.ok) throw runtimeFailure(result);
    return {
      app,
      attach: result.attach,
      message: `Profiling React renders in ${app}. Perform the interaction, then run react-devtools profile stop.`,
    };
  });
}

async function stopProfile(
  args: ProfileArgs,
  options: ReactProfileCommandOptions,
): Promise<SavedReactProfile> {
  return await withAppRuntime(args, options, async (session, target) => {
    const result = await callRuntime<StopResult>(session, 'stop');
    if (!result.ok) throw runtimeFailure(result);
    const request = selectPropKindRequests(result);
    // The recording already left the app; prop kinds only sharpen the wording of findings.
    const propKinds =
      Object.keys(request).length > 0
        ? await callRuntime<PropKindsById>(session, 'describeProps', request).catch(() => ({}))
        : {};
    const saved: SavedReactProfile = {
      savedAt: new Date().toISOString(),
      appId: targetAppId(target),
      deviceName: target.deviceName,
      analysis: analyzeReactProfile(result, propKinds),
    };
    writeSavedProfile(options, saved);
    return saved;
  });
}

function formatStatus(status: StatusResult, app: string): string {
  return status.profiling && status.elapsedMs !== null
    ? `Profiling ${app} for ${elapsed(status.elapsedMs)}.`
    : `Not profiling ${app}.`;
}

type Emit = (text: string, data: unknown) => void;
type SubcommandHandler = (
  args: ProfileArgs,
  options: ReactProfileCommandOptions,
  emit: Emit,
) => Promise<void>;

function requireComponent(
  analysis: ReactProfileAnalysis,
  name: string | undefined,
): ComponentProfile {
  if (!name)
    throw new AppError('INVALID_ARGS', 'react-devtools profile report requires a component name.');
  const component = findComponent(analysis, name);
  if (!component) {
    throw new AppError('COMMAND_FAILED', `No renders of ${name} in the saved profile.`, {
      hint: 'Use a name from react-devtools profile slow or profile rerenders.',
    });
  }
  return component;
}

function requireCommit(analysis: ReactProfileAnalysis, target: string | undefined): CommitProfile {
  const index = Number.parseInt((target ?? '').replace(/^#/, ''), 10);
  const commit = Number.isInteger(index) ? analysis.commits[index] : undefined;
  if (!commit) {
    throw new AppError('INVALID_ARGS', `No commit ${target ?? '(none)'} in the saved profile.`, {
      hint: `Use a commit index from 0 to ${Math.max(analysis.commits.length - 1, 0)}.`,
    });
  }
  return commit;
}

const SUBCOMMAND_HANDLERS: Record<ReactProfileSubcommand, SubcommandHandler> = {
  start: async (args, options, emit) => {
    const started = await startProfile(args, options);
    emit(started.message, started);
  },
  status: async (args, options, emit) => {
    const status = await withAppRuntime(args, options, async (session, target) => ({
      app: targetAppId(target),
      ...(await callRuntime<StatusResult>(session, 'status')),
    }));
    emit(formatStatus(status, status.app), status);
  },
  stop: async (args, options, emit) => {
    const saved = await stopProfile(args, options);
    const { analysis } = saved;
    emit(formatProfileSummary(analysis, args.limit ?? DEFAULT_FINDING_LIMIT), {
      appId: saved.appId,
      wallMs: analysis.wallMs,
      commitCount: analysis.commitCount,
      renderMs: analysis.renderMs,
      slowCommitCount: analysis.slowCommitCount,
      worstCommit: analysis.worstCommit,
      findings: analysis.findings.slice(0, args.limit ?? analysis.findings.length),
      savedTo: savedProfilePath(options),
    });
  },
  slow: async (args, options, emit) => {
    const { analysis } = readSavedProfile(options);
    const limit = args.limit ?? 10;
    emit(formatSlowComponents(analysis, limit), analysis.components.slice(0, limit));
  },
  rerenders: async (args, options, emit) => {
    const { analysis } = readSavedProfile(options);
    const limit = args.limit ?? 10;
    emit(formatRerenders(analysis, limit), componentsByRenders(analysis).slice(0, limit));
  },
  report: async (args, options, emit) => {
    const { analysis } = readSavedProfile(options);
    const component = requireComponent(analysis, args.target);
    emit(formatComponentReport(analysis, component), component);
  },
  timeline: async (args, options, emit) => {
    const { analysis } = readSavedProfile(options);
    const limit = args.limit ?? 20;
    const byDuration = args.sort === 'duration';
    emit(
      formatTimeline(analysis, limit, byDuration),
      timelineCommits(analysis, byDuration).slice(0, limit),
    );
  },
  commit: async (args, options, emit) => {
    const { analysis } = readSavedProfile(options);
    const commit = requireCommit(analysis, args.target);
    emit(formatCommit(commit, args.limit ?? 10), commit);
  },
};

export async function runReactProfileCommand(
  args: string[],
  options: ReactProfileCommandOptions,
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const json = options.flags?.json === true;
  const parsed = parseProfileArgs(args);
  await SUBCOMMAND_HANDLERS[parsed.subcommand](parsed, options, (text, data) => {
    write(json ? `${JSON.stringify({ success: true, data }, null, 2)}\n` : `${text}\n`);
  });
  return 0;
}
