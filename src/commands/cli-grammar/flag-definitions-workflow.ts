import { SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS } from '../../contracts/screenshot.ts';
import {
  MAESTRO_COMPAT_TRACKER_URL,
  formatMaestroSupportedSubsetForCli,
} from '../../compat/maestro/support-matrix.ts';
import type { FlagDefinition } from './flag-types.ts';

export const WORKFLOW_FLAG_DEFINITIONS: readonly FlagDefinition[] = [
  {
    key: 'replayUpdate',
    names: ['--update', '-u'],
    type: 'boolean',
    usageLabel: '--update, -u',
    usageDescription:
      'Replay: retired as a rewrite (ADR 0012) — never edits the .ad file; every divergence already ' +
      'carries ranked selector suggestions, --update or not',
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
  },
  {
    key: 'replayPlanDigest',
    names: ['--plan-digest'],
    type: 'string',
    usageLabel: '--plan-digest <sha256>',
    usageDescription:
      'Replay: the plan digest a --from resume must match (from a prior divergence report); mismatch, ' +
      'edits, or include/platform-expansion changes fail INVALID_ARGS before any action',
  },
  {
    key: 'replayMaestro',
    names: ['--maestro'],
    type: 'boolean',
    usageLabel: '--maestro',
    usageDescription:
      `Replay: treat input as a Maestro YAML compatibility flow. ${formatMaestroSupportedSubsetForCli()} ` +
      `Unsupported syntax fails loudly with a link to ${MAESTRO_COMPAT_TRACKER_URL}`,
  },
  {
    key: 'replayExportFormat',
    names: ['--format'],
    type: 'enum',
    enumValues: ['maestro'],
    usageLabel: '--format maestro',
    usageDescription: 'Replay export: output format',
  },
  {
    key: 'replayEnv',
    names: ['-e', '--env'],
    type: 'string',
    multiple: true,
    usageLabel: '-e KEY=VALUE, --env KEY=VALUE',
    usageDescription:
      'Replay/Test: inject or override a ${KEY} variable for the script (repeatable)',
  },
  {
    key: 'failFast',
    names: ['--fail-fast'],
    type: 'boolean',
    usageLabel: '--fail-fast',
    usageDescription:
      'Test: stop the suite after the first failing script; with sharding, each shard stops independently',
  },
  {
    key: 'timeoutMs',
    names: ['--timeout'],
    type: 'int',
    min: 1,
    usageLabel: '--timeout <ms>',
    usageDescription:
      'Prepare/Replay/Snapshot/Test: maximum wall-clock time for the command or attempt. With --settle: the settle-wait deadline (default 10s)',
  },
  {
    key: 'retries',
    names: ['--retries'],
    type: 'int',
    min: 0,
    max: 3,
    usageLabel: '--retries <n>',
    usageDescription: 'Test: retry each failed script up to n additional times',
  },
  {
    key: 'recordVideo',
    names: ['--record-video'],
    type: 'boolean',
    usageLabel: '--record-video',
    usageDescription: 'Test: record each replay attempt to recording.mp4 in its attempt artifacts',
  },
  {
    key: 'artifactsDir',
    names: ['--artifacts-dir'],
    type: 'string',
    usageLabel: '--artifacts-dir <path>',
    usageDescription: 'Test: root directory for suite artifacts',
  },
  {
    key: 'reporter',
    names: ['--reporter'],
    type: 'string',
    multiple: true,
    usageLabel: '--reporter <name-or-path>',
    usageDescription:
      'Test: add a replay suite reporter; use default, junit:<path>, or a custom reporter path (repeatable)',
  },
  {
    key: 'reportJunit',
    names: ['--report-junit'],
    type: 'string',
    usageLabel: '--report-junit <path>',
    usageDescription: 'Test: compatibility alias for --reporter junit:<path>',
  },
  {
    key: 'shardAll',
    names: ['--shard-all'],
    type: 'int',
    min: 1,
    usageLabel: '--shard-all <n>',
    usageDescription:
      'Test: run the full suite on each of n devices; combine with --device id1,id2 for explicit connected devices; AD_SHARD_INDEX is zero-based',
  },
  {
    key: 'shardSplit',
    names: ['--shard-split'],
    type: 'int',
    min: 1,
    usageLabel: '--shard-split <n>',
    usageDescription:
      'Test: split runnable suite entries across n devices; AD_SHARD_INDEX is zero-based',
  },
  {
    key: 'steps',
    names: ['--steps'],
    type: 'string',
    usageLabel: '--steps <json>',
    usageDescription: 'Batch: JSON array of steps',
  },
  {
    key: 'stepsFile',
    names: ['--steps-file'],
    type: 'string',
    usageLabel: '--steps-file <path>',
    usageDescription: 'Batch: read steps JSON from file',
  },
  {
    key: 'batchOnError',
    names: ['--on-error'],
    type: 'enum',
    enumValues: ['stop'],
    usageLabel: '--on-error stop',
    usageDescription: 'Batch: stop when a step fails',
  },
  {
    key: 'batchMaxSteps',
    names: ['--max-steps'],
    type: 'int',
    min: 1,
    max: 1000,
    usageLabel: '--max-steps <n>',
    usageDescription: 'Batch: maximum number of allowed steps',
  },
  {
    key: 'appsFilter',
    names: ['--all'],
    type: 'enum',
    enumValues: ['user-installed', 'all'],
    setValue: 'all',
    usageLabel: '--all',
    usageDescription: 'Apps: include system/OEM apps',
  },
  {
    key: 'snapshotInteractiveOnly',
    names: ['-i'],
    type: 'boolean',
    usageLabel: '-i',
    usageDescription: 'Snapshot: interactive elements only',
  },
  {
    key: 'snapshotDepth',
    names: ['--depth', '-d'],
    type: 'int',
    min: 0,
    usageLabel: '--depth, -d <depth>',
    usageDescription: 'Snapshot: limit snapshot depth',
  },
  {
    key: 'snapshotScope',
    names: ['--scope', '-s'],
    type: 'string',
    usageLabel: '--scope, -s <scope>',
    usageDescription: 'Snapshot: scope snapshot to label/identifier',
  },
  {
    key: 'snapshotRaw',
    names: ['--raw'],
    type: 'boolean',
    usageLabel: '--raw',
    usageDescription: 'Snapshot: raw node output',
  },
  {
    key: 'snapshotForceFull',
    names: ['--force-full'],
    type: 'boolean',
    usageLabel: '--force-full',
    usageDescription: 'Snapshot: re-emit the full tree even when unchanged',
  },
  {
    key: 'findFirst',
    names: ['--first'],
    type: 'boolean',
    usageLabel: '--first',
    usageDescription: 'Find: pick the first match when ambiguous',
  },
  {
    key: 'findLast',
    names: ['--last'],
    type: 'boolean',
    usageLabel: '--last',
    usageDescription: 'Find: pick the last match when ambiguous',
  },
  {
    key: 'out',
    names: ['--out'],
    type: 'string',
    usageLabel: '--out <path>',
    usageDescription: 'Output path',
  },
  {
    key: 'artifact',
    names: ['--artifact'],
    type: 'string',
    usageLabel: '--artifact <path>',
    usageDescription: 'Debug symbols: Apple crash artifact path (.ips, .crash, or .log)',
  },
  {
    key: 'dsym',
    names: ['--dsym'],
    type: 'string',
    usageLabel: '--dsym <path>',
    usageDescription: 'Debug symbols: matching .dSYM bundle path',
  },
  {
    key: 'searchPath',
    names: ['--search-path'],
    type: 'string',
    usageLabel: '--search-path <dir>',
    usageDescription: 'Debug symbols: directory to scan for matching .dSYM bundles',
  },
  {
    key: 'overlayRefs',
    names: ['--overlay-refs'],
    type: 'boolean',
    usageLabel: '--overlay-refs',
    usageDescription:
      'Screenshot: draw current snapshot refs and target rectangles onto the saved PNG; diff screenshot: also write a separate current-screen overlay guide',
  },
  ...SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS,
  {
    key: 'baseline',
    names: ['--baseline', '-b'],
    type: 'string',
    usageLabel: '--baseline, -b <path>',
    usageDescription: 'Diff screenshot: path to baseline image file',
  },
  {
    key: 'threshold',
    names: ['--threshold'],
    type: 'string',
    usageLabel: '--threshold <0-1>',
    usageDescription: 'Diff screenshot: color distance threshold (default 0.1)',
  },
];
