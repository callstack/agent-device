export {
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from './device-fixtures.ts';

export {
  makeAndroidSession,
  makeIosSession,
  makeMacOsSession,
  makeAuthoringSession,
  makeSession,
} from './session-factories.ts';

export { makeSnapshotState } from './snapshot-builders.ts';

export {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  androidSnapshotHelperOutput,
  androidSnapshotHelperScriptResponse,
  createAndroidSnapshotHelperExecutor,
} from './android-snapshot-helper.ts';

export { makeSessionStore } from './store-factory.ts';

export { withFakeAdb, type FakeAdbResponse } from './fake-adb.ts';

export { withFakeAppleTool, type FakeAppleToolResponse } from './fake-apple-tool.ts';

export { assertRejectsAppError } from './app-error.ts';

export {
  COMPACT_VIEWPORTS,
  distinctRectPairArb,
  formatRef,
  gestureInViewportArb,
  interactionTouchPointScenarioArb,
  PROPERTY_RUNS,
  PROPERTY_RUNS_SMALL,
  rawSnapshotNodesArb,
  refArb,
  replayScriptArb,
  scrollingContainerTypeArb,
} from './property-arbitraries.ts';

export { withNoColor } from './color.ts';

export {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
  supportsLoopbackBind,
  waitForHttpOk,
} from './loopback.ts';
