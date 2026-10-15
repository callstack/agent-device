import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import { targetAppId, type InspectorSession } from './metro-inspector.ts';
import {
  callRuntime,
  emitTo,
  parseDevtoolsArgs,
  runtimeFailure,
  RUNTIME_OPTIONS,
  withAppRuntime,
  type CommandForm,
  type DevtoolsArgs,
  type Emit,
  type ReactDevtoolsCommandOptions,
  type RuntimeFailure,
} from './react-devtools-connection.ts';
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

type ProfileArgs = DevtoolsArgs & { subcommand: ReactProfileSubcommand; target?: string };

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

type StartResult = { ok: true; attach: string } | RuntimeFailure;
type StopResult = ({ ok: true; failures: string[] } & RawReactProfile) | RuntimeFailure;

function isReactProfileSubcommand(value: string | undefined): value is ReactProfileSubcommand {
  return REACT_PROFILE_SUBCOMMANDS.includes(value as ReactProfileSubcommand);
}

function profileForm(subcommand: ReactProfileSubcommand, target: string | undefined): CommandForm {
  switch (subcommand) {
    case 'start':
      return { usage: 'profile start', positionals: 0, options: RUNTIME_OPTIONS };
    case 'stop':
      return { usage: 'profile stop', positionals: 0, options: [...RUNTIME_OPTIONS, 'limit'] };
    case 'report':
      return target === undefined
        ? { usage: 'profile report', positionals: 1, options: ['limit'] }
        : { usage: 'profile report <Component>', positionals: 1, options: [] };
    case 'commit':
      return { usage: 'profile commit', positionals: 1, options: ['limit'] };
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
  const parsed = parseDevtoolsArgs(rest, (positionals) => profileForm(subcommand, positionals[0]));
  return { ...parsed, subcommand, target: parsed.positionals[0] };
}

function savedProfilePath(options: ReactDevtoolsCommandOptions): string {
  return path.join(options.stateDir, 'react-profiles', `${safeSessionName(options.session)}.json`);
}

function writeSavedProfile(
  options: ReactDevtoolsCommandOptions,
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

function readSavedAnalysis(options: ReactDevtoolsCommandOptions): ReactProfileAnalysis {
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
  options: ReactDevtoolsCommandOptions,
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
  options: ReactDevtoolsCommandOptions,
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

type SubcommandHandler = (
  args: ProfileArgs,
  options: ReactDevtoolsCommandOptions,
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
  options: ReactDevtoolsCommandOptions,
): Promise<number> {
  const parsed = parseProfileArgs(args);
  await SUBCOMMAND_HANDLERS[parsed.subcommand](parsed, options, emitTo(options));
  return 0;
}
