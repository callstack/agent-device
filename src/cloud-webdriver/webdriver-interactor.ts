import type {
  Interactor,
  ScreenshotOptions,
  SnapshotOptions,
  SnapshotResult,
} from '../core/interactor-types.ts';
import type { BackMode } from '../contracts/back-mode.ts';
import type { DeviceRotation } from '../contracts/device-rotation.ts';
import type { ScrollDirection } from '../contracts/scroll-gesture.ts';
import type { GesturePlan } from '../contracts/gesture-plan.ts';
import type { TvRemoteButton } from '../contracts/tv-remote.ts';
import type { SettingOptions } from '../platforms/permission-utils.ts';
import { AppError } from '../kernel/errors.ts';
import { buildScrollGesturePlan } from '../contracts/scroll-gesture.ts';
import {
  capabilitySupported,
  unsupportedCapabilityMessage,
  type CloudWebDriverOperation,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import { touchPointer } from './webdriver-gestures.ts';
import type { W3CPointerAction, WebDriverClient, WebDriverWindowRect } from './webdriver-client.ts';
import { scrollFrameFromWebDriverSource } from './webdriver-scroll-frame.ts';
import { parseWebDriverSource } from './webdriver-source.ts';

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
    await this.tap(x, y);
    await this.type(text);
    return { backend: 'webdriver', x, y, text };
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

  async rotate(orientation: DeviceRotation): Promise<void> {
    this.requireSupport('rotate');
    await this.client.executeScript('mobile: rotate', [{ orientation }]);
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
