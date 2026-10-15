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
import {
  analyzeReactProfile,
  isFindingFor,
  type ReactProfileAnalysis,
} from './react-profile-analysis.ts';
import {
  selectPropKindRequests,
  type CommitProfile,
  type ComponentProfile,
  type PropKindsById,
  type RawReactProfile,
} from './react-profile-renders.ts';
import {
  DEFAULT_FINDING_LIMIT,
  findComponents,
  formatSeconds,
  formatCommit,
  formatCommits,
  formatComponentReport,
  formatComponents,
  formatProfileSummary,
  listedCommits,
} from './react-profile-format.ts';

const REACT_PROFILE_SUBCOMMANDS = ['start', 'stop', 'report', 'commit'] as const;

type ReactProfileSubcommand = (typeof REACT_PROFILE_SUBCOMMANDS)[number];

export type ReactProfileCommandOptions = {
  flags?: Partial<Pick<CliFlags, 'json' | 'leaseBackend' | 'metroPublicBaseUrl'>>;
  stateDir: string;
  session: string;
};

type ProfileArgs = {
  subcommand: ReactProfileSubcommand;
  target?: string;
  limit?: number;
  app?: string;
  metroDevice?: string;
  metroHost?: string;
  metroPort?: string;
  bundleUrl?: string;
};

const SAVED_PROFILE_VERSION = 2;

/**
 * The recording exactly as the app exported it, with what was learned about it at stop. Every view
 * analyzes it again, so none of them depends on what another view chose to keep.
 */
type SavedReactProfile = {
  version: typeof SAVED_PROFILE_VERSION;
  savedAt: string;
  appId?: string;
  deviceName?: string;
  profile: RawReactProfile;
  propKinds: PropKindsById;
  notes: string[];
};

type RuntimeFailure = { ok: false; reason: string; elapsedMs?: number; detail?: string };
type StartResult = { ok: true; attach: string } | RuntimeFailure;
type StopResult = ({ ok: true; failures: string[] } & RawReactProfile) | RuntimeFailure;

const SUBCOMMANDS_WITH_TARGET = new Set<ReactProfileSubcommand>(['report', 'commit']);
const POSITIVE_INTEGER = /^[1-9]\d*$/;

function isReactProfileSubcommand(value: string | undefined): value is ReactProfileSubcommand {
  return REACT_PROFILE_SUBCOMMANDS.includes(value as ReactProfileSubcommand);
}

const PROFILE_OPTIONS = {
  limit: { type: 'string' },
  app: { type: 'string' },
  'metro-device': { type: 'string' },
  'metro-host': { type: 'string' },
  'metro-port': { type: 'string' },
  'bundle-url': { type: 'string' },
} as const;

type ProfileOption = keyof typeof PROFILE_OPTIONS;

const RUNTIME_OPTIONS: readonly ProfileOption[] = [
  'app',
  'metro-device',
  'metro-host',
  'metro-port',
  'bundle-url',
];

/** The options each subcommand reads; any other option is refused rather than ignored. */
function subcommandOptions(
  subcommand: ReactProfileSubcommand,
  target: string | undefined,
): readonly ProfileOption[] {
  if (subcommand === 'start') return RUNTIME_OPTIONS;
  if (subcommand === 'stop') return [...RUNTIME_OPTIONS, 'limit'];
  return subcommand === 'report' && target !== undefined ? [] : ['limit'];
}

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
  const { values, positionals } = parseProfileOptions(rest);
  const unread = (Object.keys(values) as ProfileOption[]).find(
    (option) => !subcommandOptions(subcommand, positionals[0]).includes(option),
  );
  if (unread) {
    const form = subcommand === 'report' && positionals[0] ? 'report <Component>' : subcommand;
    throw new AppError('INVALID_ARGS', `react-devtools profile ${form} does not take --${unread}.`);
  }
  const expected = SUBCOMMANDS_WITH_TARGET.has(subcommand) ? 1 : 0;
  if (positionals.length > expected) {
    throw new AppError(
      'INVALID_ARGS',
      `Unexpected argument for react-devtools profile ${subcommand}: ${positionals[expected]}.`,
    );
  }
  if (values.limit !== undefined && !POSITIVE_INTEGER.test(values.limit)) {
    throw new AppError('INVALID_ARGS', `Invalid --limit: ${values.limit}. Use a positive integer.`);
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  return {
    subcommand,
    target: positionals[0],
    limit,
    app: values.app,
    metroDevice: values['metro-device'],
    metroHost: values['metro-host'],
    metroPort: values['metro-port'],
    bundleUrl: values['bundle-url'],
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
  action: (session: InspectorSession, target: MetroInspectorTarget) => Promise<T>,
): Promise<T> {
  const serverUrl = resolveDevServerUrl(args, options);
  const target = selectReactNativeTarget(await listMetroInspectorTargets(serverUrl), {
    appId: args.app,
    device: args.metroDevice,
  });
  const session: InspectorSession = await InspectorSession.connect(target.webSocketDebuggerUrl);
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
  session: InspectorSession,
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
  'collect-failed': {
    message: 'The React DevTools backend could not export the recorded profile.',
    hint: 'Run react-devtools profile start and stop again; reload the app if it keeps failing.',
  },
};

function runtimeFailure(result: RuntimeFailure): AppError {
  const known = RUNTIME_FAILURES[result.reason];
  const message = known?.message ?? `React profiling failed: ${result.reason}.`;
  return new AppError('COMMAND_FAILED', result.detail ? `${message} ${result.detail}` : message, {
    reason: result.reason,
    ...(known ? { hint: known.hint } : {}),
  });
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

function isSavedProfile(value: SavedReactProfile | undefined): value is SavedReactProfile {
  return (
    value?.version === SAVED_PROFILE_VERSION &&
    Array.isArray(value.profile?.commits) &&
    typeof value.profile.elements === 'object' &&
    Array.isArray(value.notes)
  );
}

function readSavedAnalysis(options: ReactProfileCommandOptions): ReactProfileAnalysis {
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
  if (!isSavedProfile(saved)) {
    throw new AppError('COMMAND_FAILED', 'The saved React profile has an unsupported format.', {
      hint: 'Record a new profile with react-devtools profile start and stop.',
    });
  }
  return analyzeReactProfile(saved.profile, saved.propKinds, saved.notes);
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

/**
 * Classifies changed prop values on mounted instances. The recording has already left the app, so
 * a failure here costs only that detail and is reported as a note on the analysis.
 */
async function describeChangedProps(
  session: InspectorSession,
  profile: RawReactProfile,
): Promise<{ propKinds: PropKindsById; notes: string[] }> {
  const request = selectPropKindRequests(profile);
  if (Object.keys(request).length === 0) return { propKinds: {}, notes: [] };
  try {
    return {
      propKinds: await callRuntime<PropKindsById>(session, 'describeProps', request),
      notes: [],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { propKinds: {}, notes: [`Changed prop values could not be inspected: ${reason}`] };
  }
}

async function stopProfile(
  args: ProfileArgs,
  options: ReactProfileCommandOptions,
): Promise<{ appId: string; analysis: ReactProfileAnalysis }> {
  return await withAppRuntime(args, options, async (session, target) => {
    const result = await callRuntime<StopResult>(session, 'stop');
    if (!result.ok) throw runtimeFailure(result);
    const { ok: _ok, failures, ...profile } = result;
    const described = await describeChangedProps(session, profile);
    const notes = [
      ...failures.map((failure) => `A React renderer's profile could not be read: ${failure}`),
      ...described.notes,
    ];
    const appId = targetAppId(target);
    writeSavedProfile(options, {
      version: SAVED_PROFILE_VERSION,
      savedAt: new Date().toISOString(),
      appId,
      deviceName: target.deviceName,
      profile,
      propKinds: described.propKinds,
      notes,
    });
    return { appId, analysis: analyzeReactProfile(profile, described.propKinds, notes) };
  });
}

type Emit = (text: string, data: unknown) => void;
type SubcommandHandler = (
  args: ProfileArgs,
  options: ReactProfileCommandOptions,
  emit: Emit,
) => Promise<void>;

function requireComponents(analysis: ReactProfileAnalysis, name: string): ComponentProfile[] {
  const components = findComponents(analysis, name);
  if (components.length === 0) {
    throw new AppError('COMMAND_FAILED', `No renders of ${name} in the saved profile.`, {
      hint: 'Use a name that react-devtools profile report lists.',
    });
  }
  return components;
}

function requireCommit(analysis: ReactProfileAnalysis, target: string): CommitProfile {
  const digits = target.replace(/^#/, '');
  const commit = /^\d+$/.test(digits) ? analysis.commits[Number(digits)] : undefined;
  if (!commit) {
    throw new AppError('INVALID_ARGS', `No commit ${target} in the saved profile.`, {
      hint: `Use a commit index from 0 to ${Math.max(analysis.commits.length - 1, 0)}.`,
    });
  }
  return commit;
}

const COMPONENT_LIMIT = 10;
const COMMIT_LIMIT = 20;

const SUBCOMMAND_HANDLERS: Record<ReactProfileSubcommand, SubcommandHandler> = {
  start: async (args, options, emit) => {
    const started = await startProfile(args, options);
    emit(started.message, started);
  },
  stop: async (args, options, emit) => {
    const { appId, analysis } = await stopProfile(args, options);
    emit(formatProfileSummary(analysis, args.limit ?? DEFAULT_FINDING_LIMIT), {
      appId,
      wallMs: analysis.wallMs,
      commitCount: analysis.commitCount,
      renderMs: analysis.renderMs,
      slowCommitCount: analysis.slowCommitCount,
      worstCommit: analysis.worstCommit,
      findings: analysis.findings.slice(0, args.limit ?? analysis.findings.length),
      notes: analysis.notes,
      savedTo: savedProfilePath(options),
    });
  },
  report: async (args, options, emit) => {
    const analysis = readSavedAnalysis(options);
    if (args.target === undefined) {
      const limit = args.limit ?? COMPONENT_LIMIT;
      emit(formatComponents(analysis, limit), {
        components: analysis.components.slice(0, limit),
      });
      return;
    }
    const components = requireComponents(analysis, args.target);
    emit(formatComponentReport(analysis, components), {
      components,
      findings: analysis.findings.filter((finding) =>
        components.some((component) => isFindingFor(finding, component)),
      ),
    });
  },
  commit: async (args, options, emit) => {
    const analysis = readSavedAnalysis(options);
    if (args.target === undefined) {
      const limit = args.limit ?? COMMIT_LIMIT;
      emit(formatCommits(analysis, limit), { commits: listedCommits(analysis, limit) });
      return;
    }
    const commit = requireCommit(analysis, args.target);
    const limit = args.limit ?? COMPONENT_LIMIT;
    emit(formatCommit(commit, limit), {
      ...commit,
      components: commit.components.slice(0, limit),
    });
  },
};

export async function runReactProfileCommand(
  args: string[],
  options: ReactProfileCommandOptions,
): Promise<number> {
  const json = options.flags?.json === true;
  const parsed = parseProfileArgs(args);
  await SUBCOMMAND_HANDLERS[parsed.subcommand](parsed, options, (text, data) => {
    process.stdout.write(
      json ? `${JSON.stringify({ success: true, data }, null, 2)}\n` : `${text}\n`,
    );
  });
  return 0;
}
