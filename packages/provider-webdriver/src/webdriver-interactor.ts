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
import { buildScrollGesturePlan } from '@agent-device/contracts/scroll-gesture';
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
 * How long a tapped field gets to take text entry focus before `fill` gives up.
 * Mirrors the Apple runner's `TextEntryTiming.readinessTimeout`
 * (RunnerTests+TextEntry.swift), which owns this discipline locally.
 */
const TEXT_ENTRY_READINESS_TIMEOUT_MS = 2_000;
const TEXT_ENTRY_READINESS_POLL_MS = 100;
/**
 * One keyboard probe's own transport bound. Well under the readiness budget it
 * serves, so a single hung probe cannot stretch that budget out toward the
 * WebDriver client's much longer default request timeout.
 */
const TEXT_ENTRY_PROBE_TIMEOUT_MS = 1_500;

/** Global-timer based, so text-entry readiness can be exercised on a fake clock. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Nothing took text-entry focus within the readiness budget, so `sendKeys`
 * would go to whatever else holds first responder — or nowhere. #1658 is
 * precisely the report of that being answered with "Filled N chars", so this
 * fails instead of typing: the caller gets a refusal it must handle, and the
 * field is left untouched rather than half-written.
 */
function textEntryFocusNotObservedError(x: number, y: number, detail: string): AppError {
  return new AppError('COMMAND_FAILED', `fill tapped (${x}, ${y}) but ${detail}`, {
    reason: 'text_entry_focus_not_observed',
    x,
    y,
    hint: 'The tap most likely missed the field. Re-check the target with snapshot -i and fill the element it reports, rather than retrying the same coordinates.',
  });
}

/**
 * The driver reports neither which element holds focus nor whether the keyboard
 * is up, so no wait could establish that the tap landed on a text input. A
 * distinct reason from a tap that missed: nothing about the target is wrong,
 * the grid simply cannot answer, and the caller's next move is different.
 */
function textEntryFocusUnobservableError(x: number, y: number): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `fill tapped (${x}, ${y}) but this driver reports neither the focused element nor keyboard state, so the text was not sent`,
    {
      reason: 'text_entry_focus_unobservable',
      x,
      y,
      hint: 'This provider cannot confirm a field took focus. Use press <target> followed by type <text> to enter it anyway, accepting that nothing witnesses which field receives the keys.',
    },
  );
}

function rectContains(rect: WebDriverWindowRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * What text entry looked like before the tap. Both readings are only evidence
 * as a change, so both must be captured before the device is touched.
 */
type TextEntryStateBeforeTap = {
  keyboard: boolean | 'unsupported';
  /** `undefined` when nothing was focused, or when the driver cannot say. */
  focusedElementId: string | undefined;
};

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
    if (options?.url) {
      await this.client.executeScript('mobile: deepLink', [{ url: options.url, package: app }]);
      return;
    }
    const appId = options?.appBundleId ?? app;
    if (!appId) return;
    await this.client.activateApp(appId);
  }

  async openDevice(): Promise<void> {
    await this.client.executeScript('mobile: activateApp', [{}]);
  }

  async close(app: string): Promise<void> {
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
    // #1658: both readings are taken BEFORE the tap, because each is only
    // evidence as a change. A keyboard that was already up says nothing about
    // which field owns first responder now, and a focused element is only
    // proof our tap did something if it differs from the one already focused.
    // Probe failures throw here, before the tap, so a broken session fails a
    // fill that has not touched the device rather than typing into the dark.
    const beforeTap = await this.readTextEntryState();
    await this.tap(x, y);
    const textEntryReadiness = await this.awaitTextEntryReadiness(beforeTap, x, y);
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
    // Spelled as a correlated pair per channel so the SnapshotProvenance union accepts it.
    return {
      ...(this.backend === 'xctest'
        ? { backend: 'xctest' as const, producer: 'appium-source' as const }
        : { backend: 'android' as const, producer: 'appium-source' as const }),
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

  // The four alert legs share one declared capability: a driver that cannot read a native alert
  // cannot press its buttons either, and no provider in this family declares either half.
  async readAlert(): Promise<Record<string, unknown>> {
    this.unsupported('alert');
  }

  async awaitAlert(): Promise<Record<string, unknown>> {
    this.unsupported('alert');
  }

  async acceptAlert(): Promise<Record<string, unknown>> {
    this.unsupported('alert');
  }

  async dismissAlert(): Promise<Record<string, unknown>> {
    this.unsupported('alert');
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
    beforeTap: TextEntryStateBeforeTap,
    x: number,
    y: number,
  ): Promise<CloudTextEntryReadiness> {
    const keyboardBeforeTap = beforeTap.keyboard;
    const deadline = Date.now() + TEXT_ENTRY_READINESS_TIMEOUT_MS;
    // Strongest evidence first: the focused element itself. Keyboard visibility
    // can only witness that *a* field took focus, never *which* — which is why
    // filling a second field in an already-open form could send its keys to the
    // first one.
    //
    // The question is whether OUR tap moved focus, so compare against what held
    // it before. Identity rather than geometry, because focusing a field can
    // re-lay it out: tapping Safari's collapsed address bar expands it into a
    // taller search field that no longer contains the point that was tapped, so
    // a containment-only rule refuses a fill that plainly worked. Containment
    // still earns its place as the second half of the test — re-filling the
    // field that is ALREADY focused moves nothing, and only geometry can tell
    // that from a tap that missed everything.
    const focusedBeforeTap = beforeTap.focusedElementId;
    const focus = await this.pollWithinBudget(deadline, async (timeoutMs) => {
      const active = await this.client.activeElement(timeoutMs);
      if (active === 'unsupported') return 'abandon';
      if (active === 'none') return 'retry';
      const moved = active.id !== focusedBeforeTap;
      return moved || rectContains(active.rect, x, y) ? 'satisfied' : 'retry';
    });
    if (focus === 'satisfied') return 'focused-element';
    if (focus === 'expired') {
      throw textEntryFocusNotObservedError(
        x,
        y,
        'nothing there took text-entry focus, so the text was not sent',
      );
    }

    // No active-element route. Fall back to keyboard evidence, which can still
    // witness focus arriving when the keyboard was down before our tap.
    if (keyboardBeforeTap === 'unsupported') {
      // Neither route: nothing this fill can wait for would mean anything. It
      // used to settle briefly and type, reporting ordinary success — but
      // nothing renders `textEntryReadiness`, so that read to a caller exactly
      // like a fill that worked, which is the #1658 false success this whole
      // change exists to remove. Refusing is the only honest answer, and it
      // leaves `press` + `type` as the deliberate way to enter text unwitnessed.
      throw textEntryFocusUnobservableError(x, y);
    }
    if (keyboardBeforeTap) {
      // Keyboard already up and no way to ask which field owns it: every signal
      // available here describes the PREVIOUS field. Typing anyway is exactly
      // #1658's silent misdelivery, so refuse instead.
      throw textEntryFocusNotObservedError(
        x,
        y,
        'the keyboard was already up and this driver cannot report which field holds focus, so the text was not sent',
      );
    }
    const keyboard = await this.pollWithinBudget(deadline, async (timeoutMs) =>
      (await this.client.isKeyboardShown(timeoutMs)) === true ? 'satisfied' : 'retry',
    );
    if (keyboard === 'satisfied') return 'keyboard-shown';
    throw textEntryFocusNotObservedError(x, y, 'no keyboard appeared, so the text was not sent');
  }

  /** Both pre-tap readings, taken together so neither is charged an extra tap-to-probe gap. */
  private async readTextEntryState(): Promise<TextEntryStateBeforeTap> {
    const [keyboard, active] = await Promise.all([
      this.client.isKeyboardShown(TEXT_ENTRY_PROBE_TIMEOUT_MS),
      this.client.activeElement(TEXT_ENTRY_PROBE_TIMEOUT_MS),
    ]);
    return {
      keyboard,
      focusedElementId: active === 'none' || active === 'unsupported' ? undefined : active.id,
    };
  }

  /**
   * Polls until `probe` is satisfied or the readiness budget runs out, bounding
   * BOTH the probe's own transport timeout and the sleep between attempts by
   * what remains — a probe handed the full fixed timeout near the deadline
   * would otherwise finish well after the budget it was meant to respect.
   *
   * A probe that throws is tolerated: the loop has further attempts, and one
   * transient grid error should not fail a fill that would have succeeded. But
   * a budget that expires without a single answered probe rethrows, so a dead
   * session or an auth rejection surfaces as itself instead of being reported
   * as a tap that missed its field.
   */
  private async pollWithinBudget(
    deadline: number,
    probe: (timeoutMs: number) => Promise<'satisfied' | 'abandon' | 'retry'>,
  ): Promise<'satisfied' | 'abandon' | 'expired'> {
    let answered = false;
    let lastError: unknown;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const verdict = await probe(Math.min(TEXT_ENTRY_PROBE_TIMEOUT_MS, remaining));
        answered = true;
        if (verdict !== 'retry') return verdict;
      } catch (error) {
        lastError = error;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(TEXT_ENTRY_READINESS_POLL_MS, left));
    }
    if (!answered && lastError !== undefined) throw lastError;
    return 'expired';
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
