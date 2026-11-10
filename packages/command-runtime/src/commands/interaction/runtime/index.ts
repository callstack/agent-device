import type { AgentDeviceRuntime } from '@agent-device/contracts/runtime-contract';
import type { BoundRuntimeCommand, RuntimeCommand } from '../../runtime-types.ts';
import {
  clickCommand,
  fillCommand,
  hoverCommand,
  longPressCommand,
  pressCommand,
  type ClickCommandOptions,
  type FillCommandOptions,
  type FillCommandResult,
  type HoverCommandOptions,
  type HoverCommandResult,
  type InteractionTarget,
  type LongPressCommandOptions,
  type LongPressCommandResult,
  type PressCommandOptions,
  type PressCommandResult,
} from './interactions.ts';
import {
  findCommand,
  getCommand,
  waitCommand,
  type FindReadCommandOptions,
  type FindReadCommandResult,
  type GetCommandOptions,
  type GetCommandResult,
  type WaitCommandOptions,
  type WaitCommandResult,
} from './selector-read.ts';
import { isCommand, type IsCommandOptions, type IsCommandResult } from './selector-is.ts';
import {
  gestureCommand,
  type GestureCommandOptions,
  type GestureCommandResult,
} from './gesture-command.ts';
import { settleObservationCommand, type SettleObservationCommandOptions } from './settle.ts';
import type { SettleObservation } from '@agent-device/contracts/interaction';

export type SelectorCommands = {
  find: RuntimeCommand<FindReadCommandOptions, FindReadCommandResult>;
  get: RuntimeCommand<GetCommandOptions, GetCommandResult>;
  is: RuntimeCommand<IsCommandOptions, IsCommandResult>;
  wait: RuntimeCommand<WaitCommandOptions, WaitCommandResult>;
};

export type InteractionCommands = {
  click: RuntimeCommand<ClickCommandOptions, PressCommandResult>;
  press: RuntimeCommand<PressCommandOptions, PressCommandResult>;
  fill: RuntimeCommand<FillCommandOptions, FillCommandResult>;
  longPress: RuntimeCommand<LongPressCommandOptions, LongPressCommandResult>;
  hover: RuntimeCommand<HoverCommandOptions, HoverCommandResult>;
  gesture: RuntimeCommand<GestureCommandOptions, GestureCommandResult>;
  /**
   * #1638: the observation half of `--settle` for mutations that resolve no
   * element (`scroll`/`back`). It performs no device action — the caller's
   * command already did — so it lives here purely as the seam the generic
   * daemon route reaches the settle engine through.
   */
  settleObservation: RuntimeCommand<SettleObservationCommandOptions, SettleObservation>;
};

export type BoundSelectorCommands = {
  find: BoundRuntimeCommand<FindReadCommandOptions, FindReadCommandResult>;
  get: BoundRuntimeCommand<GetCommandOptions, GetCommandResult>;
  is: BoundRuntimeCommand<IsCommandOptions, IsCommandResult>;
  wait: BoundRuntimeCommand<WaitCommandOptions, WaitCommandResult>;
};

export type BoundInteractionCommands = {
  click: (
    target: InteractionTarget,
    options?: Omit<ClickCommandOptions, 'target'>,
  ) => Promise<PressCommandResult>;
  press: (
    target: InteractionTarget,
    options?: Omit<PressCommandOptions, 'target'>,
  ) => Promise<PressCommandResult>;
  fill: (
    target: InteractionTarget,
    text: string,
    options?: Omit<FillCommandOptions, 'target' | 'text'>,
  ) => Promise<FillCommandResult>;
  longPress: (
    target: InteractionTarget,
    options?: Omit<LongPressCommandOptions, 'target'>,
  ) => Promise<LongPressCommandResult>;
  hover: (
    target: InteractionTarget,
    options?: Omit<HoverCommandOptions, 'target'>,
  ) => Promise<HoverCommandResult>;
  gesture: BoundRuntimeCommand<GestureCommandOptions, GestureCommandResult>;
  settleObservation: BoundRuntimeCommand<SettleObservationCommandOptions, SettleObservation>;
};

const selectorCommands: SelectorCommands = {
  find: findCommand,
  get: getCommand,
  is: isCommand,
  wait: waitCommand,
};

const interactionCommands: InteractionCommands = {
  click: clickCommand,
  press: pressCommand,
  fill: fillCommand,
  longPress: longPressCommand,
  hover: hoverCommand,
  gesture: gestureCommand,
  settleObservation: settleObservationCommand,
};

export function bindSelectorCommands(runtime: AgentDeviceRuntime): BoundSelectorCommands {
  return {
    find: (options) => selectorCommands.find(runtime, options),
    get: (options) => selectorCommands.get(runtime, options),
    is: (options) => selectorCommands.is(runtime, options),
    wait: (options) => selectorCommands.wait(runtime, options),
  };
}

export function bindInteractionCommands(runtime: AgentDeviceRuntime): BoundInteractionCommands {
  return {
    click: (target, options = {}) => interactionCommands.click(runtime, { ...options, target }),
    press: (target, options = {}) => interactionCommands.press(runtime, { ...options, target }),
    fill: (target, text, options = {}) =>
      interactionCommands.fill(runtime, { ...options, target, text }),
    longPress: (target, options = {}) =>
      interactionCommands.longPress(runtime, { ...options, target }),
    hover: (target, options = {}) => interactionCommands.hover(runtime, { ...options, target }),
    gesture: (options) => interactionCommands.gesture(runtime, options),
    settleObservation: (options) => interactionCommands.settleObservation(runtime, options),
  };
}

export type { GestureCommandOptions, GestureCommandResult } from './gesture-command.ts';
