import type { AgentDeviceRuntime } from '../../../runtime-contract.ts';
import type { BoundRuntimeCommand, RuntimeCommand } from '../../runtime-types.ts';
import {
  clickCommand,
  fillCommand,
  focusCommand,
  hoverCommand,
  longPressCommand,
  pressCommand,
  scrollCommand,
  type ClickCommandOptions,
  type FillCommandOptions,
  type FillCommandResult,
  type FocusCommandOptions,
  type FocusCommandResult,
  type HoverCommandOptions,
  type HoverCommandResult,
  type InteractionTarget,
  type LongPressCommandOptions,
  type LongPressCommandResult,
  type PressCommandOptions,
  type PressCommandResult,
  type ScrollCommandOptions,
  type ScrollCommandResult,
} from './interactions.ts';
import {
  findCommand,
  getAttrsCommand,
  getCommand,
  getTextCommand,
  isCommand,
  isHiddenCommand,
  isVisibleCommand,
  waitCommand,
  waitForTextCommand,
  type ElementTarget,
  type FindReadCommandOptions,
  type FindReadCommandResult,
  type GetAttrsCommandOptions,
  type GetCommandOptions,
  type GetCommandResult,
  type GetTextCommandOptions,
  type IsCommandOptions,
  type IsCommandResult,
  type IsSelectorCommandOptions,
  type SelectorTarget,
  type WaitCommandOptions,
  type WaitCommandResult,
  type WaitForTextCommandOptions,
} from './selector-read.ts';
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
  getText: RuntimeCommand<GetTextCommandOptions, Extract<GetCommandResult, { kind: 'text' }>>;
  getAttrs: RuntimeCommand<GetAttrsCommandOptions, Extract<GetCommandResult, { kind: 'attrs' }>>;
  is: RuntimeCommand<IsCommandOptions, IsCommandResult>;
  isVisible: RuntimeCommand<IsSelectorCommandOptions, IsCommandResult>;
  isHidden: RuntimeCommand<IsSelectorCommandOptions, IsCommandResult>;
  wait: RuntimeCommand<WaitCommandOptions, WaitCommandResult>;
  waitForText: RuntimeCommand<
    WaitForTextCommandOptions,
    Extract<WaitCommandResult, { kind: 'text' }>
  >;
};

export type InteractionCommands = {
  click: RuntimeCommand<ClickCommandOptions, PressCommandResult>;
  press: RuntimeCommand<PressCommandOptions, PressCommandResult>;
  fill: RuntimeCommand<FillCommandOptions, FillCommandResult>;
  focus: RuntimeCommand<FocusCommandOptions, FocusCommandResult>;
  longPress: RuntimeCommand<LongPressCommandOptions, LongPressCommandResult>;
  hover: RuntimeCommand<HoverCommandOptions, HoverCommandResult>;
  scroll: RuntimeCommand<ScrollCommandOptions, ScrollCommandResult>;
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
  getText: (
    target: ElementTarget,
    options?: Omit<GetTextCommandOptions, 'target'>,
  ) => Promise<Extract<GetCommandResult, { kind: 'text' }>>;
  getAttrs: (
    target: ElementTarget,
    options?: Omit<GetAttrsCommandOptions, 'target'>,
  ) => Promise<Extract<GetCommandResult, { kind: 'attrs' }>>;
  is: BoundRuntimeCommand<IsCommandOptions, IsCommandResult>;
  isVisible: (
    target: SelectorTarget,
    options?: Omit<IsSelectorCommandOptions, 'target'>,
  ) => Promise<IsCommandResult>;
  isHidden: (
    target: SelectorTarget,
    options?: Omit<IsSelectorCommandOptions, 'target'>,
  ) => Promise<IsCommandResult>;
  wait: BoundRuntimeCommand<WaitCommandOptions, WaitCommandResult>;
  waitForText: (
    text: string,
    options?: Omit<WaitForTextCommandOptions, 'text'>,
  ) => Promise<Extract<WaitCommandResult, { kind: 'text' }>>;
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
  focus: (
    target: InteractionTarget,
    options?: Omit<FocusCommandOptions, 'target'>,
  ) => Promise<FocusCommandResult>;
  longPress: (
    target: InteractionTarget,
    options?: Omit<LongPressCommandOptions, 'target'>,
  ) => Promise<LongPressCommandResult>;
  hover: (
    target: InteractionTarget,
    options?: Omit<HoverCommandOptions, 'target'>,
  ) => Promise<HoverCommandResult>;
  scroll: BoundRuntimeCommand<ScrollCommandOptions, ScrollCommandResult>;
  gesture: BoundRuntimeCommand<GestureCommandOptions, GestureCommandResult>;
  settleObservation: BoundRuntimeCommand<SettleObservationCommandOptions, SettleObservation>;
};

export const selectorCommands: SelectorCommands = {
  find: findCommand,
  get: getCommand,
  getText: getTextCommand,
  getAttrs: getAttrsCommand,
  is: isCommand,
  isVisible: isVisibleCommand,
  isHidden: isHiddenCommand,
  wait: waitCommand,
  waitForText: waitForTextCommand,
};

export const interactionCommands: InteractionCommands = {
  click: clickCommand,
  press: pressCommand,
  fill: fillCommand,
  focus: focusCommand,
  longPress: longPressCommand,
  hover: hoverCommand,
  scroll: scrollCommand,
  gesture: gestureCommand,
  settleObservation: settleObservationCommand,
};

export function bindSelectorCommands(runtime: AgentDeviceRuntime): BoundSelectorCommands {
  return {
    find: (options) => selectorCommands.find(runtime, options),
    get: (options) => selectorCommands.get(runtime, options),
    getText: (target, options = {}) => selectorCommands.getText(runtime, { ...options, target }),
    getAttrs: (target, options = {}) => selectorCommands.getAttrs(runtime, { ...options, target }),
    is: (options) => selectorCommands.is(runtime, options),
    isVisible: (target, options = {}) =>
      selectorCommands.isVisible(runtime, { ...options, target }),
    isHidden: (target, options = {}) => selectorCommands.isHidden(runtime, { ...options, target }),
    wait: (options) => selectorCommands.wait(runtime, options),
    waitForText: (text, options = {}) =>
      selectorCommands.waitForText(runtime, { ...options, text }),
  };
}

export function bindInteractionCommands(runtime: AgentDeviceRuntime): BoundInteractionCommands {
  return {
    click: (target, options = {}) => interactionCommands.click(runtime, { ...options, target }),
    press: (target, options = {}) => interactionCommands.press(runtime, { ...options, target }),
    fill: (target, text, options = {}) =>
      interactionCommands.fill(runtime, { ...options, target, text }),
    focus: (target, options = {}) => interactionCommands.focus(runtime, { ...options, target }),
    longPress: (target, options = {}) =>
      interactionCommands.longPress(runtime, { ...options, target }),
    hover: (target, options = {}) => interactionCommands.hover(runtime, { ...options, target }),
    scroll: (options) => interactionCommands.scroll(runtime, options),
    gesture: (options) => interactionCommands.gesture(runtime, options),
    settleObservation: (options) => interactionCommands.settleObservation(runtime, options),
  };
}

export type { GestureCommandOptions, GestureCommandResult } from './gesture-command.ts';
