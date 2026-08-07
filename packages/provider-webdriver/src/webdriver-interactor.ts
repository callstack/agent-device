import type { DeviceRotation } from '@agent-device/contracts/device';
import type {
  BackMode,
  CloudTextEntryReadiness,
  GesturePlan,
  Interactor,
  ScreenshotOptions,
  ScrollDirection,
  SnapshotOptions,
  SnapshotResult,
  TvRemoteButton,
} from '@agent-device/contracts/interaction';
import { buildScrollGesturePlan } from '@agent-device/contracts/interaction';
import type { SettingOptions } from '@agent-device/contracts/settings';
import { AppError } from '@agent-device/kernel/errors';
import {
  capabilitySupported,
  unsupportedCapabilityMessage,
  type CloudWebDriverOperation,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import type { W3CPointerAction, WebDriverClient, WebDriverWindowRect } from './webdriver-client.ts';
import { touchPointer } from './webdriver-gestures.ts';
import { scrollFrameFromWebDriverSource } from './webdriver-scroll-frame.ts';
import { parseWebDriverSource } from './webdriver-source.ts';
import { setWebDriverOrientation } from './webdriver-orientation.ts';

/**
 * How long a tapped field gets to take text entry focus before `fill` types
 * anyway. Mirrors the Apple runner's `TextEntryTiming.readinessTimeout`
 * (RunnerTests+TextEntry.swift), which owns this discipline locally.
 */
const TEXT_ENTRY_READINESS_TIMEOUT_MS = 2_000;
const TEXT_ENTRY_READINESS_POLL_MS = 100;
/** The blind wait when the driver reports no keyboard state at all — see `awaitTextEntryReadiness`. */
const TEXT_ENTRY_BLIND_SETTLE_MS = 350;

/** Global-timer based, so text-entry readiness can be exercised on a fake clock. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WebDriverInteractorOptions = {
  client: WebDriverClient;
  backend: Extract<SnapshotResult['backend'], 'android' | 'xctest'>;
  capabilities: CloudWebDriverProviderCapabilities;
};

export function createWebDriverInteractor(options: WebDriverInteractorOptions): Interactor {
  return new WebDriverInteractor(options.client, options.backend, options.capabilities);
}

class WebDriverInteractor implements Interactor {
  private readonly client: WebDriverClient;
  private readonly backend: Extract<SnapshotResult['backend'], 'android' | 'xctest'>;
  private readonly capabilities: CloudWebDriverProviderCapabilities;

  constructor(
    client: WebDriverClient,
    backend: Extract<SnapshotResult['backend'], 'android' | 'xctest'>,
    capabilities: CloudWebDriverProviderCapabilities,
  ) {
    this.client = client;
    this.backend = backend;
    this.capabilities = capabilities;
  }

  async open(
    app: string,
    options?: {
      activity?: string;
      appBundleId?: string;
      launchConsole?: string;
      launchArgs?: string[];
      url?: string;
    },
  ): Promise<void> {
    this.requireSupport('open');
    if (options?.url) {
      await this.client.executeScript('mobile: deepLink', [{ url: options.url, package: app }]);
      return;
    }
    const appId = options?.appBundleId ?? app;
    if (!appId) return;
    await this.client.activateApp(appId);
  }

  async openDevice(): Promise<void> {
    this.requireSupport('open');
    await this.client.executeScript('mobile: activateApp', [{}]);
  }

  async close(app: string): Promise<void> {
    this.requireSupport('close');
    if (!app) return;
    await this.client.terminateApp(app);
  }

  async tap(x: number, y: number): Promise<Record<string, unknown>> {
    this.requireSupport('tap');
    await this.pointerGesture('tap', [
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]);
    return { backend: 'webdriver', x, y };
  }

  async doubleTap(x: number, y: number): Promise<Record<string, unknown>> {
    this.requireSupport('doubleTap');
    await this.pointerGesture('doubleTap', [
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
      { type: 'pause', duration: 80 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]);
    return { backend: 'webdriver', x, y };
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 400,
  ): Promise<Record<string, unknown>> {
    this.requireSupport('swipe');
    await this.pointerGesture('swipe', [
      { type: 'pointerMove', duration: 0, x: x1, y: y1 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: durationMs, x: x2, y: y2 },
      { type: 'pointerUp', button: 0 },
    ]);
    return { backend: 'webdriver', x1, y1, x2, y2, durationMs };
  }

  async longPress(x: number, y: number, durationMs = 600): Promise<Record<string, unknown>> {
    this.requireSupport('longPress');
    await this.pointerGesture('longPress', [
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: durationMs },
      { type: 'pointerUp', button: 0 },
    ]);
    return { backend: 'webdriver', x, y, durationMs };
  }

  async focus(x: number, y: number): Promise<Record<string, unknown>> {
    return await this.tap(x, y);
  }

  async type(text: string): Promise<void> {
    this.requireSupport('type');
    await this.client.sendKeys(text);
  }

  async fill(
    x: number,
    y: number,
    text: string,
    _delayMs?: number,
  ): Promise<Record<string, unknown>> {
    this.requireSupport('fill');
    // #1658: read the keyboard BEFORE the tap. Only a hidden -> shown
    // transition proves that OUR tap moved focus; a keyboard that was already
    // up says nothing about which field owns first responder now.
    const keyboardBeforeTap = await this.tryReadKeyboardShown();
    await this.tap(x, y);
    const textEntryReadiness = await this.awaitTextEntryReadiness(keyboardBeforeTap);
    await this.type(text);
    return { backend: 'webdriver', x, y, text, textEntryReadiness };
  }

  async scroll(
    direction: ScrollDirection,
    options?: { amount?: number; pixels?: number; durationMs?: number },
  ): Promise<Record<string, unknown>> {
    this.requireSupport('scroll');
    const durationMs = options?.durationMs ?? 350;
    await this.client.hideKeyboard().catch(() => undefined);
    const rect = await this.scrollGestureFrame();
    const plan = buildScrollGesturePlan({
      direction,
      amount: options?.amount,
      pixels: options?.pixels,
      referenceWidth: rect.width,
      referenceHeight: rect.height,
    });
    const absolutePlan = {
      ...plan,
      x1: plan.x1 + rect.x,
      y1: plan.y1 + rect.y,
      x2: plan.x2 + rect.x,
      y2: plan.y2 + rect.y,
    };
    await this.swipe(
      absolutePlan.x1,
      absolutePlan.y1,
      absolutePlan.x2,
      absolutePlan.y2,
      durationMs,
    );
    return { backend: 'webdriver', ...absolutePlan, distance: plan.pixels, durationMs };
  }

  async gestureViewport(): Promise<WebDriverWindowRect> {
    return await this.scrollGestureFrame();
  }

  async performGesture(plan: GesturePlan): Promise<Record<string, unknown>> {
    this.requireSupport(webDriverOperationForGesture(plan));
    await this.client.performActions(
      plan.pointers.map((pointer) =>
        touchPointer(`gesture-pointer-${pointer.pointerId}`, pointerActions(pointer.samples)),
      ),
    );
    await this.client.releaseActions().catch(() => undefined);
    return { backend: 'webdriver-w3c-actions' };
  }

  async screenshot(outPath: string, _options?: ScreenshotOptions): Promise<void> {
    this.requireSupport('screenshot');
    await this.client.screenshot(outPath);
  }

  async snapshot(_options?: SnapshotOptions): Promise<SnapshotResult> {
    this.requireSupport('snapshot');
    return {
      backend: this.backend,
      nodes: parseWebDriverSource(await this.client.source()),
    };
  }

  async back(_mode?: BackMode): Promise<void> {
    this.requireSupport('back');
    await this.client.back();
  }

  async home(): Promise<void> {
    this.requireSupport('home');
    await this.client.executeScript('mobile: pressButton', [{ name: 'home' }]);
  }

  async setOrientation(orientation: DeviceRotation): Promise<void> {
    this.requireSupport('orientation');
    await setWebDriverOrientation(this.client, this.backend, orientation);
  }

  async appSwitcher(): Promise<void> {
    this.requireSupport('appSwitcher');
    await this.client.executeScript('mobile: pressButton', [{ name: 'appSwitch' }]);
  }

  async tvRemote(_button: TvRemoteButton, _durationMs?: number): Promise<void> {
    this.unsupported('tvRemote');
  }

  async readClipboard(): Promise<string> {
    this.requireSupport('clipboard.read');
    const value = await this.client.executeScript('mobile: getClipboard', [{}]);
    return typeof value === 'string' ? value : '';
  }

  async writeClipboard(text: string): Promise<void> {
    this.requireSupport('clipboard.write');
    await this.client.executeScript('mobile: setClipboard', [{ content: text }]);
  }

  async setSetting(
    _setting: string,
    _state: string,
    _appId?: string,
    _options?: SettingOptions,
  ): Promise<Record<string, unknown> | void> {
    this.unsupported('settings');
  }

  /**
   * The cloud twin of the local Apple runner's focus -> readiness -> type
   * pipeline (RunnerTests+TextEntry.swift). A WebView input does not take first
   * responder synchronously with the tap: the page has to process the touch and
   * raise the keyboard. `fill` used to send its keys in the very next request,
   * so on a slow web login form they landed with nothing focused — reported as
   * "Filled N chars" while the field kept its placeholder. That is also why
   * tapping and filling as two separate commands was the reliable workaround:
   * only the round trip between them gave the field time to focus.
   */
  private async awaitTextEntryReadiness(
    keyboardBeforeTap: boolean | undefined,
  ): Promise<CloudTextEntryReadiness> {
    // The driver answers nothing about the keyboard, so no wait can learn
    // anything. Keep a blind path cheap: settle briefly, then type.
    if (keyboardBeforeTap === undefined) {
      await sleep(TEXT_ENTRY_BLIND_SETTLE_MS);
      return 'settled-unknown';
    }
    // The keyboard was ALREADY up — back-to-back fills into one form, the shape
    // that failed most often in #1658. Its visibility cannot witness focus
    // moving to the NEW field, so polling it would resolve instantly on
    // evidence about the PREVIOUS one. The Apple runner spends its whole
    // readiness budget on exactly this case rather than race the app with a
    // short settle; the cloud path has even more reason to, because its keys go
    // to whatever holds first responder rather than to a scoped element.
    if (keyboardBeforeTap) {
      await sleep(TEXT_ENTRY_READINESS_TIMEOUT_MS);
      return 'settled-keyboard-up';
    }
    const deadline = Date.now() + TEXT_ENTRY_READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(TEXT_ENTRY_READINESS_POLL_MS);
      if ((await this.tryReadKeyboardShown()) === true) return 'keyboard-shown';
    }
    // The tap opened no keyboard. Still send the keys — a text view without a
    // software keyboard (hardware keyboard attached, or a non-editable target
    // the caller means to type at) is a real case, and refusing would turn a
    // recoverable miss into a hard failure — but say so, so the caller is not
    // told "filled" by a fill that had no witness.
    return 'not-observed';
  }

  /** Keyboard state is evidence, never a precondition: a driver that cannot answer must not fail the fill. */
  private async tryReadKeyboardShown(): Promise<boolean | undefined> {
    return await this.client.isKeyboardShown().catch(() => undefined);
  }

  private async pointerGesture(name: string, actions: W3CPointerAction[]): Promise<void> {
    await this.client.performActions([touchPointer(name, actions)]);
    // Some Appium grids accept W3C actions but reject DELETE /actions. A failed
    // best-effort input-state reset should not make the completed gesture fail.
    await this.client.releaseActions().catch(() => undefined);
  }

  private async scrollGestureFrame(): Promise<WebDriverWindowRect> {
    const sourceFrame = await this.client
      .source()
      .then((source) => scrollFrameFromWebDriverSource(source))
      .catch(() => undefined);
    if (sourceFrame) return sourceFrame;
    return await this.client.windowRect();
  }

  private requireSupport(operation: CloudWebDriverOperation): void {
    if (capabilitySupported(this.capabilities, operation)) return;
    this.unsupported(operation);
  }

  private unsupported(operation: CloudWebDriverOperation): never {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      unsupportedCapabilityMessage(this.capabilities, operation),
      {
        provider: this.capabilities.provider,
        platform: this.capabilities.platform,
        operation,
      },
    );
  }
}

function pointerActions(samples: GesturePlan['pointers'][number]['samples']): W3CPointerAction[] {
  const first = samples[0];
  if (!first) throw new AppError('INVALID_ARGS', 'WebDriver gesture pointer requires samples');
  const actions: W3CPointerAction[] = [
    { type: 'pointerMove', duration: 0, x: first.point.x, y: first.point.y },
    { type: 'pointerDown', button: 0 },
  ];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const sample = samples[index]!;
    actions.push({
      type: 'pointerMove',
      duration: sample.offsetMs - previous.offsetMs,
      x: sample.point.x,
      y: sample.point.y,
    });
  }
  actions.push({ type: 'pointerUp', button: 0 });
  return actions;
}

function webDriverOperationForGesture(plan: GesturePlan): CloudWebDriverOperation {
  if (plan.topology === 'single') return 'swipe';
  switch (plan.intent) {
    case 'pan':
    case 'transform':
      return 'transformGesture';
    case 'pinch':
      return 'pinch';
    case 'rotate':
      return 'rotateGesture';
  }
}
