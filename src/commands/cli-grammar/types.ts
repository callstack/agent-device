import type { InteractionTarget, InternalRequestOptions } from '../../client/client-types.ts';
import type { CommandFlags } from '../../core/dispatch-context.ts';
import type { CliFlags } from './flag-types.ts';
import type { ClickButton } from '../../core/click-button.ts';
import type { DecodedFillTarget } from '../../core/interaction-positionals.ts';
import type { WaitParsed } from '../../core/wait-positionals.ts';

export type DaemonCommandRequest = {
  command: string;
  positionals: string[];
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
    scale?: number;
    selector?: string;
    source?: InternalRequestOptions['installSource'];
    state?: string;
    text?: string;
    to?: PointInput;
    update?: boolean;
    url?: string;
    value?: string;
    velocity?: number;
    x?: number;
    y?: number;
  } & Record<string, unknown>;

export type SelectionOptions = {
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
export type DaemonWriter = (input: CommandInput) => DaemonCommandRequest;

export type { DecodedFillTarget, InteractionTarget, WaitParsed };
