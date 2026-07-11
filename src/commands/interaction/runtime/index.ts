import type { AgentDeviceRuntime } from '../../../runtime-contract.ts';
import type { BoundRuntimeCommand, RuntimeCommand } from '../../runtime-types.ts';
import {
  clickCommand,
  fillCommand,
  focusCommand,
  longPressCommand,
  pinchCommand,
  pressCommand,
  scrollCommand,
  swipeCommand,
  typeTextCommand,
  type ClickCommandOptions,
  type FillCommandOptions,
  type FillCommandResult,
  type FocusCommandOptions,
  type FocusCommandResult,
  type InteractionTarget,
  type LongPressCommandOptions,
  type LongPressCommandResult,
  type PinchCommandOptions,
  type PinchCommandResult,
  type PressCommandOptions,
  type PressCommandResult,
  type ScrollCommandOptions,
  type ScrollCommandResult,
  type SwipeCommandOptions,
  type SwipeCommandResult,
  type TypeTextCommandOptions,
  type TypeTextCommandResult,
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
  flingCommand,
  gestureCommand,
  panCommand,
  rotateGestureCommand,
  transformGestureCommand,
  type FlingCommandOptions,
  type GestureCommandOptions,
  type GestureCommandResult,
  type PanCommandOptions,
  type RotateGestureCommandOptions,
  type TransformGestureCommandOptions,
} from './gesture-command.ts';

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
  typeText: RuntimeCommand<TypeTextCommandOptions, TypeTextCommandResult>;
  focus: RuntimeCommand<FocusCommandOptions, FocusCommandResult>;
  longPress: RuntimeCommand<LongPressCommandOptions, LongPressCommandResult>;
  swipe: RuntimeCommand<SwipeCommandOptions, SwipeCommandResult>;
  scroll: RuntimeCommand<ScrollCommandOptions, ScrollCommandResult>;
  pinch: RuntimeCommand<PinchCommandOptions, PinchCommandResult>;
  gesture: RuntimeCommand<GestureCommandOptions, GestureCommandResult>;
  pan: RuntimeCommand<PanCommandOptions, GestureCommandResult>;
  fling: RuntimeCommand<FlingCommandOptions, GestureCommandResult>;
  rotateGesture: RuntimeCommand<RotateGestureCommandOptions, GestureCommandResult>;
  transformGesture: RuntimeCommand<TransformGestureCommandOptions, GestureCommandResult>;
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
  typeText: (
    text: string,
    options?: Omit<TypeTextCommandOptions, 'text'>,
  ) => Promise<TypeTextCommandResult>;
  focus: (
    target: InteractionTarget,
    options?: Omit<FocusCommandOptions, 'target'>,
  ) => Promise<FocusCommandResult>;
  longPress: (
    target: InteractionTarget,
    options?: Omit<LongPressCommandOptions, 'target'>,
  ) => Promise<LongPressCommandResult>;
  swipe: BoundRuntimeCommand<SwipeCommandOptions, SwipeCommandResult>;
  scroll: BoundRuntimeCommand<ScrollCommandOptions, ScrollCommandResult>;
  pinch: BoundRuntimeCommand<PinchCommandOptions, PinchCommandResult>;
  gesture: BoundRuntimeCommand<GestureCommandOptions, GestureCommandResult>;
  pan: BoundRuntimeCommand<PanCommandOptions, GestureCommandResult>;
  fling: BoundRuntimeCommand<FlingCommandOptions, GestureCommandResult>;
  rotateGesture: BoundRuntimeCommand<RotateGestureCommandOptions, GestureCommandResult>;
  transformGesture: BoundRuntimeCommand<TransformGestureCommandOptions, GestureCommandResult>;
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
  typeText: typeTextCommand,
  focus: focusCommand,
  longPress: longPressCommand,
  swipe: swipeCommand,
  scroll: scrollCommand,
  pinch: pinchCommand,
  gesture: gestureCommand,
  pan: panCommand,
  fling: flingCommand,
  rotateGesture: rotateGestureCommand,
  transformGesture: transformGestureCommand,
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
    typeText: (text, options = {}) => interactionCommands.typeText(runtime, { ...options, text }),
    focus: (target, options = {}) => interactionCommands.focus(runtime, { ...options, target }),
    longPress: (target, options = {}) =>
      interactionCommands.longPress(runtime, { ...options, target }),
    swipe: (options) => interactionCommands.swipe(runtime, options),
    scroll: (options) => interactionCommands.scroll(runtime, options),
    pinch: (options) => interactionCommands.pinch(runtime, options),
    gesture: (options) => interactionCommands.gesture(runtime, options),
    pan: (options) => interactionCommands.pan(runtime, options),
    fling: (options) => interactionCommands.fling(runtime, options),
    rotateGesture: (options) => interactionCommands.rotateGesture(runtime, options),
    transformGesture: (options) => interactionCommands.transformGesture(runtime, options),
  };
}

export type {
  FlingCommandOptions,
  GestureCommandOptions,
  GestureCommandResult,
  PanCommandOptions,
  RotateGestureCommandOptions,
  TransformGestureCommandOptions,
} from './gesture-command.ts';
