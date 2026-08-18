import type { InternalRequestOptions } from '@agent-device/contracts/client';
import type { CliFlags, CommandFlags } from '@agent-device/contracts/command';
import type { ClickButton } from '@agent-device/contracts/interaction';

export type DaemonCommandRequest = {
  command: string;
  positionals: string[];
  input?: Record<string, unknown>;
  options: InternalRequestOptions;
  metadataFlags?: Partial<CommandFlags>;
};

type PointInput = {
  x?: number;
  y?: number;
};

export type CommandInput = Omit<InternalRequestOptions, 'batchSteps' | 'target'> &
  Omit<Partial<CliFlags>, 'batchSteps' | 'target'> & {
    target?: InternalRequestOptions['target'] | Record<string, unknown>;
    action?: string;
    amount?: number;
    app?: string;
    appPath?: string;
    backend?: string;
    degrees?: number;
    direction?: string;
    distance?: number;
    durationMs?: number;
    dx?: number;
    dy?: number;
    delta?: PointInput;
    env?: string[];
    event?: string;
    format?: string;
    from?: PointInput;
    include?: CliFlags['networkInclude'];
    kind?: string;
    keepSession?: boolean;
    locator?: string;
    mode?: 'in-app' | 'system' | 'full' | 'limited';
    button?: ClickButton;
    first?: boolean;
    last?: boolean;
    maxSteps?: number;
    onError?: 'stop';
    origin?: PointInput;
    path?: string;
    paths?: string[];
    payload?: unknown;
    permission?: string;
    predicate?: string;
    query?: string;
    retainPaths?: boolean;
    retentionMs?: number;
    // ADR 0012 decision 4 / migration step 5: replay-only resume. Named
    // `resumeFrom`/`resumePlanDigest` (not `from`/`planDigest`) — `from` is
    // already a gesture `PointInput` on this shared flat type.
    resumeFrom?: number;
    resumePlanDigest?: string;
    scale?: number;
    selector?: string;
    source?: InternalRequestOptions['installSource'];
    state?: string;
    text?: string;
    to?: PointInput;
    update?: boolean;
    url?: string;
    value?: string;
    x?: number;
    y?: number;
  } & Record<string, unknown>;

export type SelectionOptions = {
  /** `--no-record`: common to every recordable command (see `selectionOptionsFromFlags`). */
  noRecord?: boolean;
  platform?: CliFlags['platform'];
  target?: CliFlags['target'];
  device?: string;
  udid?: string;
  serial?: string;
  iosSimulatorDeviceSet?: string;
  androidDeviceAllowlist?: string;
};

export type CliInput = Record<string, unknown>;
export type CliReader = (positionals: string[], flags: CliFlags) => CliInput;
/** Builds the daemon request for one command. Most writers are pure projections of their input. */
export type DaemonWriter = (input: CommandInput) => DaemonCommandRequest;

/**
 * A writer that has caller-side work to do before the request exists: reading the replay script
 * files the request carries (#1802), which for a Maestro flow also loads the engine that walks its
 * `runFlow` includes on demand. The registry awaits whichever kind a command declares, so the
 * asynchrony stays inside the one writer that needs it.
 */
export type AsyncDaemonWriter = (input: CommandInput) => Promise<DaemonCommandRequest>;

export type AnyDaemonWriter = DaemonWriter | AsyncDaemonWriter;
