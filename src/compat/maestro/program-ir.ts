export type MaestroScalar = string | number | boolean | null;

export type MaestroSourceLocation = {
  path?: string;
  line: number;
};

export type MaestroPlatform = 'android' | 'ios' | 'web';

export type MaestroDirection = 'up' | 'down' | 'left' | 'right';

export type MaestroCoordinate =
  | { space: 'absolute'; x: number; y: number }
  | { space: 'percent'; x: number; y: number };

export type MaestroSelectorMap = {
  text?: string;
  id?: string;
  label?: string;
  enabled?: boolean;
  selected?: boolean;
};

export type MaestroSelector = MaestroSelectorMap;

export type MaestroOptionalCommand = {
  optional?: boolean;
};

export type MaestroGestureTarget =
  | MaestroCoordinate
  | { space: 'target'; selector: MaestroSelector };

export type MaestroLaunchArguments =
  | { kind: 'scalar'; value: string | number | boolean }
  | { kind: 'list'; values: Array<string | number | boolean> }
  | { kind: 'map'; values: Record<string, string | number | boolean> };

export type MaestroLaunchAppCommand = {
  kind: 'launchApp';
  source: MaestroSourceLocation;
  appId?: string;
  stopApp?: boolean;
  clearState?: boolean;
  arguments?: MaestroLaunchArguments;
  launchArguments?: MaestroLaunchArguments;
};

export type MaestroTapOnCommand = MaestroOptionalCommand & {
  kind: 'tapOn';
  source: MaestroSourceLocation;
  target: MaestroGestureTarget;
  retryTapIfNoChange?: boolean;
  repeat?: number;
  delay?: number;
  label?: string;
  index?: number;
  childOf?: MaestroSelector;
};

export type MaestroDoubleTapOnCommand = MaestroOptionalCommand & {
  kind: 'doubleTapOn';
  source: MaestroSourceLocation;
  target: MaestroGestureTarget;
  delay?: number;
};

export type MaestroLongPressOnCommand = MaestroOptionalCommand & {
  kind: 'longPressOn';
  source: MaestroSourceLocation;
  target: MaestroGestureTarget;
};

export type MaestroSwipeGesture =
  | {
      kind: 'coordinates';
      start: MaestroCoordinate;
      end: MaestroCoordinate;
      duration?: number;
    }
  | {
      kind: 'screen';
      direction: MaestroDirection;
      duration?: number;
    }
  | {
      kind: 'target';
      from: MaestroSelector;
      direction: MaestroDirection;
      duration?: number;
      label?: string;
    };

export type MaestroSwipeCommand = MaestroOptionalCommand & {
  kind: 'swipe';
  source: MaestroSourceLocation;
  gesture: MaestroSwipeGesture;
};

export type MaestroInputTextCommand = {
  kind: 'inputText';
  source: MaestroSourceLocation;
  text: string;
  label?: string;
};

export type MaestroEraseTextCommand = {
  kind: 'eraseText';
  source: MaestroSourceLocation;
  charactersToErase?: number;
};

export type MaestroOpenLinkCommand = {
  kind: 'openLink';
  source: MaestroSourceLocation;
  link: string;
};

export type MaestroAssertVisibleCommand = MaestroOptionalCommand & {
  kind: 'assertVisible';
  source: MaestroSourceLocation;
  target: MaestroSelector;
};

export type MaestroAssertNotVisibleCommand = MaestroOptionalCommand & {
  kind: 'assertNotVisible';
  source: MaestroSourceLocation;
  target: MaestroSelector;
};

export type MaestroExtendedWaitUntilCommand = MaestroOptionalCommand & {
  kind: 'extendedWaitUntil';
  source: MaestroSourceLocation;
  visible?: MaestroSelector;
  notVisible?: MaestroSelector;
  timeout?: number;
};

export type MaestroTakeScreenshotCommand = {
  kind: 'takeScreenshot';
  source: MaestroSourceLocation;
  path: string;
};

export type MaestroScrollCommand = {
  kind: 'scroll';
  source: MaestroSourceLocation;
};

export type MaestroScrollUntilVisibleCommand = MaestroOptionalCommand & {
  kind: 'scrollUntilVisible';
  source: MaestroSourceLocation;
  element: MaestroSelector;
  direction?: MaestroDirection;
  timeout?: number;
};

export type MaestroHideKeyboardCommand = {
  kind: 'hideKeyboard';
  source: MaestroSourceLocation;
};

export type MaestroPressKeyCommand = {
  kind: 'pressKey';
  source: MaestroSourceLocation;
  key: 'back' | 'enter' | 'return' | 'home';
};

export type MaestroBackCommand = {
  kind: 'back';
  source: MaestroSourceLocation;
};

export type MaestroWaitForAnimationToEndCommand = {
  kind: 'waitForAnimationToEnd';
  source: MaestroSourceLocation;
  timeout?: number;
};

export type MaestroStopAppCommand = {
  kind: 'stopApp';
  source: MaestroSourceLocation;
  appId?: string;
};

export type MaestroRunScriptCommand = {
  kind: 'runScript';
  source: MaestroSourceLocation;
  file: string;
  env?: Record<string, string | number | boolean>;
};

export type MaestroRunFlowCondition = {
  platform?: MaestroPlatform;
  visible?: MaestroSelector;
  notVisible?: MaestroSelector;
  true?: boolean | string;
};

export type MaestroRunFlowCommand = {
  kind: 'runFlow';
  source: MaestroSourceLocation;
  include: { kind: 'file'; path: string } | { kind: 'commands'; commands: MaestroCommand[] };
  when?: MaestroRunFlowCondition;
  env?: Record<string, string | number | boolean>;
  label?: string;
};

export type MaestroRepeatCommand = {
  kind: 'repeat';
  source: MaestroSourceLocation;
  times: number | string;
  commands: MaestroCommand[];
};

export type MaestroRetryCommand = {
  kind: 'retry';
  source: MaestroSourceLocation;
  maxRetries?: number | string;
  commands: MaestroCommand[];
};

export type MaestroCommand =
  | MaestroLaunchAppCommand
  | MaestroTapOnCommand
  | MaestroDoubleTapOnCommand
  | MaestroLongPressOnCommand
  | MaestroSwipeCommand
  | MaestroInputTextCommand
  | MaestroEraseTextCommand
  | MaestroOpenLinkCommand
  | MaestroAssertVisibleCommand
  | MaestroAssertNotVisibleCommand
  | MaestroExtendedWaitUntilCommand
  | MaestroTakeScreenshotCommand
  | MaestroScrollCommand
  | MaestroScrollUntilVisibleCommand
  | MaestroHideKeyboardCommand
  | MaestroPressKeyCommand
  | MaestroBackCommand
  | MaestroWaitForAnimationToEndCommand
  | MaestroStopAppCommand
  | MaestroRunScriptCommand
  | MaestroRunFlowCommand
  | MaestroRepeatCommand
  | MaestroRetryCommand;

export type MaestroProgramConfig = {
  name?: string;
  appId?: string;
  tags?: string[];
  env?: Record<string, string | number | boolean>;
  onFlowStart?: MaestroCommand[];
  onFlowComplete?: MaestroCommand[];
};

export type MaestroProgram = {
  kind: 'program';
  source: MaestroSourceLocation;
  config: MaestroProgramConfig;
  commands: MaestroCommand[];
};

export type MaestroProgramParseOptions = {
  sourcePath?: string;
};
