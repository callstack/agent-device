import fs from 'node:fs';
import path from 'node:path';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { FillBackendResult, Interactor } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import type { NomacClient, NomacToolResult } from './client.ts';

/**
 * A NoMac phone driven through simulator-use's tools on it: touches and text as `ui_act` steps at
 * points (`tap @x,y`, `hold @x,y 0.8`, `fill @x,y "text"`), apps through `app_control`, the screen
 * through `ui_look`.
 */
export type NomacPhoneSession = Readonly<{
  client: NomacClient;
  phoneId: string;
}>;

export function createNomacIosInteractor(session: NomacPhoneSession): Interactor {
  return new NomacIosInteractor(session);
}

/** Hold applied when the caller names no duration; matches the other interactors. */
const DEFAULT_LONG_PRESS_MS = 800;

class NomacIosInteractor implements Interactor {
  private readonly session: NomacPhoneSession;

  constructor(session: NomacPhoneSession) {
    this.session = session;
  }

  async open(app: string, options?: { url?: string; launchArgs?: string[] }): Promise<void> {
    if (options?.launchArgs?.length) {
      throw unsupported(
        'open',
        "NoMac launches an app without arguments; pass values through app_run's env instead.",
      );
    }
    if (options?.url) {
      await this.appControl({ action: 'launch', app });
      await this.appControl({ action: 'open_url', value: options.url });
      return;
    }
    if (isDeepLinkTarget(app)) {
      await this.appControl({ action: 'open_url', value: app });
      return;
    }
    await this.appControl({ action: 'launch', app });
  }

  async openDevice(): Promise<void> {}

  async close(app: string): Promise<void> {
    if (app) await this.appControl({ action: 'terminate', app }).catch(() => {});
  }

  async tap(x: number, y: number): Promise<void> {
    await this.act([`tap ${point(x, y)}`]);
  }

  /** Both taps in one call, so the phone runs them back to back with no network round trip between. */
  async doubleTap(x: number, y: number): Promise<void> {
    await this.act([`tap ${point(x, y)}`, `tap ${point(x, y)}`]);
  }

  async longPress(x: number, y: number, durationMs = DEFAULT_LONG_PRESS_MS): Promise<void> {
    const seconds = Math.min(10, Math.max(0.1, durationMs / 1000));
    await this.act([`hold ${point(x, y)} ${Number(seconds.toFixed(2))}`]);
  }

  async focus(x: number, y: number): Promise<void> {
    await this.tap(x, y);
  }

  /** Types into whatever holds focus. A delay types one character at a time. */
  async type(text: string, delayMs?: number): Promise<void> {
    if (delayMs && delayMs > 0) {
      for (const char of Array.from(text)) {
        await this.act([`type ${JSON.stringify(char)}`]);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return;
    }
    await this.act([`type ${JSON.stringify(text)}`]);
  }

  /**
   * simulator-use's fill taps the field at the point, replaces its text, and reads the field back: a
   * field that shows something else fails the call. So a fill that answers has seen its own field
   * take the text.
   */
  async fill(x: number, y: number, text: string): Promise<FillBackendResult> {
    await this.act([`fill ${point(x, y)} ${JSON.stringify(text)}`]);
    return { textEntryReadiness: 'focused-element' };
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    await this.act([`scroll ${direction}`]);
  }

  /** NoMac serves the screen as JPEG; the PNG-only readers behind `outPath` get a PNG. */
  async screenshot(outPath: string): Promise<void> {
    const look = await this.session.client.tool(this.session.phoneId, 'ui_look', {
      screenshot: true,
    });
    const image = look.content.find((c) => c.type === 'image' && c.data);
    if (look.isError || !image?.data) throw failure('screenshot', look);
    const { transcodeScreenshotToPngAsync } =
      await import('@agent-device/capture-kit/png-worker-client');
    const png = await transcodeScreenshotToPngAsync(
      Buffer.from(image.data, 'base64'),
      'NoMac iOS screenshot',
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, png);
  }

  async snapshot() {
    const { captureNomacIosSnapshot } = await import('./snapshot.ts');
    return await captureNomacIosSnapshot(this.session.client, this.session.phoneId);
  }

  async back(): Promise<void> {
    await this.act(['back']);
  }

  async home(): Promise<void> {
    await this.act(['home']);
  }

  async setOrientation(): Promise<void> {
    unsupported('orientation', 'NoMac phones stay in portrait for now.');
  }

  async setSetting(): Promise<void> {
    unsupported(
      'settings',
      "NoMac sets appearance, locale, time zone and location at the phone's start, not from agent-device.",
    );
  }

  private async act(steps: string[]): Promise<NomacToolResult> {
    const result = await this.session.client.tool(this.session.phoneId, 'ui_act', { steps });
    if (result.isError) throw failure(steps[0]!.split(' ')[0]!, result);
    return result;
  }

  private async appControl(args: Record<string, unknown>): Promise<NomacToolResult> {
    const result = await this.session.client.tool(this.session.phoneId, 'app_control', args);
    if (result.isError) throw failure(String(args.action), result);
    return result;
  }
}

/** Points as ui_act takes them: whole points when they are, else two decimals. */
function point(x: number, y: number): string {
  const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  return `@${f(x)},${f(y)}`;
}

function failure(command: string, result: NomacToolResult): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `NoMac's phone could not ${command}: ${result.text.split('\n')[0]?.slice(0, 300) || 'no answer'}`,
    {
      command,
      phoneAnswer: result.text.slice(0, 2000),
    },
  );
}

function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}
