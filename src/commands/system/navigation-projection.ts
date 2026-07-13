import { BACK_MODES, type BackMode } from '../../contracts/back-mode.ts';
import { DEVICE_ROTATIONS, type DeviceRotation } from '../../contracts/device-rotation.ts';
import type {
  AppSwitcherCommandResult,
  BackCommandResult,
  HomeCommandResult,
  OrientationCommandResult,
  TvRemoteCommandResult,
} from '../../contracts/navigation.ts';
import { TV_REMOTE_BUTTONS, type TvRemoteButton } from '../../contracts/tv-remote.ts';
import type { ExecutableCommandProjection } from '../command-contract.ts';

declare const navigationCommandProjectionType: unique symbol;

type NavigationCommandProjection<
  Options,
  Result,
  Required extends boolean,
  ClientMethod extends string,
> = ExecutableCommandProjection<ClientMethod> & {
  readonly [navigationCommandProjectionType]?: {
    options: Options;
    result: Result;
    required: Required;
  };
};

function defineNavigationCommandProjection<
  Options,
  Result,
  Required extends boolean,
  const ClientMethod extends string,
>(
  projection: ExecutableCommandProjection<ClientMethod>,
): NavigationCommandProjection<Options, Result, Required, ClientMethod> {
  return projection;
}

export const NAVIGATION_COMMAND_PROJECTIONS = {
  back: defineNavigationCommandProjection<{ mode?: BackMode }, BackCommandResult, false, 'back'>({
    clientMethod: 'back',
    outputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'back' },
        mode: { type: 'string', enum: BACK_MODES },
        message: { type: 'string' },
      },
      required: ['action', 'mode', 'message'],
    },
  }),
  home: defineNavigationCommandProjection<{}, HomeCommandResult, false, 'home'>({
    clientMethod: 'home',
    outputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'home' },
        message: { type: 'string' },
      },
      required: ['action', 'message'],
    },
  }),
  orientation: defineNavigationCommandProjection<
    { orientation: DeviceRotation },
    OrientationCommandResult,
    true,
    'orientation'
  >({
    clientMethod: 'orientation',
    outputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'orientation' },
        orientation: { type: 'string', enum: DEVICE_ROTATIONS },
        message: { type: 'string' },
      },
      required: ['action', 'orientation', 'message'],
    },
  }),
  'app-switcher': defineNavigationCommandProjection<
    {},
    AppSwitcherCommandResult,
    false,
    'appSwitcher'
  >({
    clientMethod: 'appSwitcher',
    outputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'app-switcher' },
        message: { type: 'string' },
      },
      required: ['action', 'message'],
    },
  }),
  'tv-remote': defineNavigationCommandProjection<
    { button: TvRemoteButton; durationMs?: number },
    TvRemoteCommandResult,
    true,
    'tvRemote'
  >({
    clientMethod: 'tvRemote',
    outputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'tv-remote' },
        button: { type: 'string', enum: TV_REMOTE_BUTTONS },
        durationMs: { type: 'number' },
        message: { type: 'string' },
      },
      required: ['action', 'button', 'message'],
    },
  }),
} as const;

export type NavigationCommandName = keyof typeof NAVIGATION_COMMAND_PROJECTIONS;

export type NavigationCommandOptions<Name extends NavigationCommandName> =
  (typeof NAVIGATION_COMMAND_PROJECTIONS)[Name] extends NavigationCommandProjection<
    infer Options,
    unknown,
    boolean,
    string
  >
    ? Options
    : never;

type ProjectedNavigationCommandMethod<BaseOptions, Projection> =
  Projection extends NavigationCommandProjection<
    infer Options,
    infer Result,
    infer Required,
    string
  >
    ? Required extends true
      ? (options: BaseOptions & Options) => Promise<Result>
      : (options?: BaseOptions & Options) => Promise<Result>
    : never;

export type ProjectedNavigationCommandClient<BaseOptions> = {
  [Name in NavigationCommandName as (typeof NAVIGATION_COMMAND_PROJECTIONS)[Name]['clientMethod']]: ProjectedNavigationCommandMethod<
    BaseOptions,
    (typeof NAVIGATION_COMMAND_PROJECTIONS)[Name]
  >;
};
