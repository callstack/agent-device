import { SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS } from '@agent-device/contracts/capture';
import type { FlagDefinition } from './flag-types.ts';

/**
 * The policy head's CLI vocabulary and defaults.
 *
 * They live beside the flags that publish them so the prose and the runtime read one declaration:
 * `--max-steps` and `--min-confidence` state these numbers in their help, and the act loop applies
 * them. Kept here rather than in the policy modules because the CLI surface is evaluated at
 * startup while the policy runtime loads on demand, and a constant may not drag the second into
 * the first.
 */
export const POLICY_PROVIDER_NAMES = ['jev'] as const;
export const DEFAULT_POLICY_PROVIDER: (typeof POLICY_PROVIDER_NAMES)[number] = 'jev';
export const DEFAULT_POLICY_MAX_STEPS = 12;
export const DEFAULT_POLICY_MIN_CONFIDENCE = 0.4;
/** Environment entry the jev provider reads its credential from; never a flag. */
export const POLICY_API_KEY_ENV = 'TYPESAFE_API_KEY';
/** Prefix for per-key text entries, so a secret never has to appear in argv. */
export const POLICY_INPUT_ENV_PREFIX = 'AGENT_DEVICE_INPUT_';

export const WORKFLOW_FLAG_DEFINITIONS: readonly FlagDefinition[] = [
  {
    key: 'replayUpdate',
    names: ['--update', '-u'],
    type: 'boolean',
    usageLabel: '--update, -u',
    usageDescription:
      'Replay: retired as a rewrite (ADR 0012) — never edits the .ad file; every divergence already ' +
      'carries ranked selector suggestions, --update or not',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'replayFrom',
    names: ['--from'],
    type: 'int',
    min: 1,
    usageLabel: '--from <n>',
    usageDescription:
      'Replay: resume at 1-based plan step n, skipping 1..n-1 without executing them (requires ' +
      "--plan-digest; see a divergence report's resume field). replay only, not test",
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'replayPlanDigest',
    names: ['--plan-digest'],
    type: 'string',
    usageLabel: '--plan-digest <sha256>',
    usageDescription:
      'Replay: the plan digest a --from resume must match (from a prior divergence report); mismatch, ' +
      'edits, or include/platform-expansion changes fail INVALID_ARGS before any action',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'replayKeepSession',
    names: ['--keep-session'],
    type: 'boolean',
    usageLabel: '--keep-session',
    usageDescription:
      'Replay: leave the session active by suppressing exactly an authored terminal close in a native .ad script; replay only, not test or Maestro YAML',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'replayMaestro',
    names: ['--maestro'],
    type: 'boolean',
    usageLabel: '--maestro',
    usageDescription:
      'Replay: treat input as a supported Maestro YAML subset; unsupported syntax fails loudly. ' +
      'See agent-device help maestro for commands and boundaries',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'replayEnv',
    names: ['-e', '--env'],
    type: 'string',
    multiple: true,
    usageLabel: '-e KEY=VALUE, --env KEY=VALUE',
    usageDescription:
      'Replay/Test: inject or override a ${KEY} variable for the script (repeatable)',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'failFast',
    names: ['--fail-fast'],
    type: 'boolean',
    usageLabel: '--fail-fast',
    usageDescription:
      'Test: stop the suite after the first failing script; with sharding, each shard stops independently',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'timeoutMs',
    names: ['--timeout'],
    type: 'int',
    min: 1,
    usageLabel: '--timeout <ms>',
    usageDescription:
      'Open/Prepare: startup budget covering the Simulator boot (and runner preparation for prepare). Replay/Snapshot/Test: maximum wall-clock time for the command or attempt. With --settle: the settle-wait deadline (default 10s)',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'retries',
    names: ['--retries'],
    type: 'int',
    min: 0,
    max: 3,
    usageLabel: '--retries <n>',
    usageDescription: 'Test: retry each failed script up to n additional times',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'recordVideo',
    names: ['--record-video'],
    type: 'boolean',
    usageLabel: '--record-video',
    usageDescription: 'Test: record each replay attempt to recording.mp4 in its attempt artifacts',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'artifactsDir',
    names: ['--artifacts-dir'],
    type: 'string',
    usageLabel: '--artifacts-dir <path>',
    usageDescription: 'Test: root directory for suite artifacts',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'reporter',
    names: ['--reporter'],
    type: 'string',
    multiple: true,
    usageLabel: '--reporter <name-or-path>',
    usageDescription:
      'Test: add a replay suite reporter; use default, junit:<path>, or a custom reporter path (repeatable)',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'reportJunit',
    names: ['--report-junit'],
    type: 'string',
    usageLabel: '--report-junit <path>',
    usageDescription: 'Test: compatibility alias for --reporter junit:<path>',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'shardAll',
    names: ['--shard-all'],
    type: 'int',
    min: 1,
    usageLabel: '--shard-all <n>',
    usageDescription:
      'Test: run the full suite on each of n devices; combine with --device id1,id2 for explicit connected devices; AD_SHARD_INDEX is zero-based',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'shardSplit',
    names: ['--shard-split'],
    type: 'int',
    min: 1,
    usageLabel: '--shard-split <n>',
    usageDescription:
      'Test: split runnable suite entries across n devices; AD_SHARD_INDEX is zero-based',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'steps',
    names: ['--steps'],
    type: 'string',
    usageLabel: '--steps <json>',
    usageDescription: 'Batch: JSON array of {"command","input"} steps',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'stepsFile',
    names: ['--steps-file'],
    type: 'string',
    usageLabel: '--steps-file <path>',
    usageDescription: 'Batch: read steps JSON from file',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'batchOnError',
    names: ['--on-error'],
    type: 'enum',
    enumValues: ['stop'],
    usageLabel: '--on-error stop',
    usageDescription: 'Batch: stop when a step fails',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'batchMaxSteps',
    names: ['--max-steps'],
    type: 'int',
    min: 1,
    max: 1000,
    usageLabel: '--max-steps <n>',
    usageDescription: `Batch: maximum allowed steps; act: stop the loop after this many steps (default ${DEFAULT_POLICY_MAX_STEPS})`,
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'appsFilter',
    names: ['--all'],
    type: 'enum',
    enumValues: ['user-installed', 'all'],
    setValue: 'all',
    usageLabel: '--all',
    usageDescription: 'Apps: include system/OEM apps',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'snapshotInteractiveOnly',
    names: ['-i'],
    type: 'boolean',
    usageLabel: '-i',
    usageDescription: 'Snapshot: interactive elements only',
    projectConfig: true,
    recorded: true,
  },
  {
    key: 'snapshotDepth',
    names: ['--depth', '-d'],
    type: 'int',
    min: 0,
    usageLabel: '--depth, -d <depth>',
    usageDescription: 'Snapshot: limit snapshot depth',
    projectConfig: true,
    recorded: true,
  },
  {
    key: 'snapshotScope',
    names: ['--scope', '-s'],
    type: 'string',
    usageLabel: '--scope, -s <scope>',
    usageDescription: 'Snapshot: scope snapshot to label/identifier',
    projectConfig: true,
    recorded: true,
  },
  {
    key: 'snapshotRaw',
    names: ['--raw'],
    type: 'boolean',
    usageLabel: '--raw',
    usageDescription: 'Snapshot: raw node output',
    projectConfig: true,
    recorded: true,
  },
  {
    key: 'snapshotCustomActions',
    names: ['--actions'],
    type: 'boolean',
    usageLabel: '--actions',
    usageDescription:
      'Snapshot: name the affordances merged inside an element (iOS sim); not directly invokable — reach them via the detail screen, labeled children, or coordinates',
    inputDescription:
      'Name the affordances an element merged away (iOS UIAccessibilityCustomAction, React Native accessibilityActions) — a card whose reply/options controls are not separate elements still lists them here. The names are for PLANNING, not invocation: there is no API to trigger them, so reach the affordance through the element detail screen, through the same control exposed as a labeled element elsewhere, or by coordinates from its rect. iOS simulator only; costs one accessibility round trip per merged element.',
    projectConfig: true,
    recorded: true,
  },
  {
    key: 'snapshotForceFull',
    names: ['--force-full'],
    type: 'boolean',
    usageLabel: '--force-full',
    usageDescription: 'Snapshot: re-emit the full tree even when unchanged',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'findFirst',
    names: ['--first'],
    type: 'boolean',
    usageLabel: '--first',
    usageDescription: 'Find: pick the first match when ambiguous',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'findLast',
    names: ['--last'],
    type: 'boolean',
    usageLabel: '--last',
    usageDescription: 'Find: pick the last match when ambiguous',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'out',
    names: ['--out'],
    type: 'string',
    usageLabel: '--out <path>',
    usageDescription: 'Output path',
    projectConfig: false,
    recorded: true,
  },
  {
    key: 'artifact',
    names: ['--artifact'],
    type: 'string',
    usageLabel: '--artifact <path>',
    usageDescription: 'Debug symbols: Apple crash artifact path (.ips, .crash, or .log)',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'dsym',
    names: ['--dsym'],
    type: 'string',
    usageLabel: '--dsym <path>',
    usageDescription: 'Debug symbols: matching .dSYM bundle path',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'searchPath',
    names: ['--search-path'],
    type: 'string',
    usageLabel: '--search-path <dir>',
    usageDescription: 'Debug symbols: directory to scan for matching .dSYM bundles',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'policy',
    names: ['--policy'],
    type: 'string',
    usageLabel: '--policy <name>',
    usageDescription: `suggest/act: policy head that decides the next element (default ${DEFAULT_POLICY_PROVIDER})`,
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'minConfidence',
    names: ['--min-confidence'],
    type: 'number',
    usageLabel: '--min-confidence <n>',
    usageDescription: `act: escalate instead of acting below this policy confidence (default ${DEFAULT_POLICY_MIN_CONFIDENCE})`,
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'policyInput',
    names: ['--input'],
    type: 'string',
    multiple: true,
    usageLabel: '--input <key=value>',
    usageDescription:
      'act: repeatable text the loop may enter, matched to a field by identifier or label; the loop never generates text',
    inputDescription:
      'Text the loop may enter, as key=value. The key matches a field identifier or label.',
    projectConfig: false,
    recorded: false,
  },
  {
    key: 'overlayRefs',
    names: ['--overlay-refs'],
    type: 'boolean',
    usageLabel: '--overlay-refs',
    usageDescription:
      'Screenshot: draw current snapshot refs and target rectangles onto the saved PNG; diff screenshot: also write a separate current-screen overlay guide',
    projectConfig: true,
    recorded: false,
  },
  ...SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS,
  {
    key: 'baseline',
    names: ['--baseline', '-b'],
    type: 'string',
    usageLabel: '--baseline, -b <path>',
    usageDescription: 'Diff screenshot: path to baseline image file',
    projectConfig: true,
    recorded: false,
  },
  {
    key: 'threshold',
    names: ['--threshold'],
    type: 'string',
    usageLabel: '--threshold <0-1>',
    usageDescription: 'Diff screenshot: color distance threshold (default 0.1)',
    projectConfig: true,
    recorded: false,
  },
];
