import fs from 'node:fs';
import type { WebProvider } from '../../../src/platforms/web/provider.ts';
import type { RawSnapshotNode } from '../../../src/utils/snapshot.ts';
import { validPng } from './assertions.ts';
import { PROVIDER_SCENARIO_WEB } from './fixtures.ts';
import { createProviderScenarioHarness, type ProviderScenarioHarness } from './harness.ts';
import type { FlatToolCall } from './providers.ts';

const INPUT_RECT = { x: 24, y: 96, width: 240, height: 36 };
const BUTTON_RECT = { x: 24, y: 148, width: 120, height: 36 };

type WebPageState = {
  openedTarget: string;
  inputValue: string;
  statusText: string;
  scrolled: boolean;
};

export type WebDesktopWorld = {
  daemon: ProviderScenarioHarness;
  semanticCalls: FlatToolCall[];
  close: () => Promise<void>;
};

export async function createWebDesktopWorld(): Promise<WebDesktopWorld> {
  const semanticCalls: FlatToolCall[] = [];
  const state: WebPageState = {
    openedTarget: 'about:blank',
    inputValue: '',
    statusText: 'Ready',
    scrolled: false,
  };

  const provider: WebProvider = {
    open: async (target, options) => {
      semanticCalls.push(['web', 'open', target, options?.url ?? '']);
      state.openedTarget = target;
      state.statusText = 'Ready';
    },
    close: async (target) => {
      semanticCalls.push(['web', 'close', target ?? '']);
    },
    snapshot: async (options) => {
      semanticCalls.push([
        'web',
        'snapshot',
        String(options?.interactiveOnly ?? ''),
        String(options?.surface ?? ''),
      ]);
      return { nodes: webSnapshotNodes(state), truncated: false };
    },
    screenshot: async (outPath, options) => {
      semanticCalls.push([
        'web',
        'screenshot',
        outPath,
        String(options?.fullscreen ?? ''),
        String(options?.stabilize ?? ''),
        String(options?.surface ?? ''),
      ]);
      fs.writeFileSync(outPath, validPng());
    },
    setViewport: async (width, height) => {
      semanticCalls.push(['web', 'viewport', String(width), String(height)]);
    },
    click: async (x, y) => {
      semanticCalls.push(['web', 'click', String(x), String(y)]);
      if (pointInRect(x, y, BUTTON_RECT)) {
        state.statusText = 'Submitted';
      }
    },
    clickRef: async (ref) => {
      semanticCalls.push(['web', 'clickRef', ref]);
      if (ref === '@e4') {
        state.statusText = 'Submitted';
      }
    },
    fill: async (x, y, text, options) => {
      semanticCalls.push([
        'web',
        'fill',
        String(x),
        String(y),
        text,
        String(options?.delayMs ?? 0),
      ]);
      if (pointInRect(x, y, INPUT_RECT)) {
        state.inputValue = text;
      }
    },
    fillRef: async (ref, text, options) => {
      semanticCalls.push(['web', 'fillRef', ref, text, String(options?.delayMs ?? 0)]);
      if (ref === '@e3') {
        state.inputValue = text;
      }
    },
    typeText: async (text, options) => {
      semanticCalls.push(['web', 'type', text, String(options?.delayMs ?? 0)]);
      state.inputValue += text;
    },
    scroll: async (direction, options) => {
      semanticCalls.push([
        'web',
        'scroll',
        direction,
        String(options?.amount ?? ''),
        String(options?.pixels ?? ''),
      ]);
      state.scrolled = true;
    },
  };

  const daemon = await createProviderScenarioHarness({
    webProvider: () => provider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_WEB],
  });

  let closed = false;
  return {
    daemon,
    semanticCalls,
    close: async () => {
      if (closed) return;
      closed = true;
      await daemon.close();
    },
  };
}

function webSnapshotNodes(state: WebPageState): RawSnapshotNode[] {
  return [
    {
      index: 0,
      role: 'document',
      label: state.openedTarget,
      rect: { x: 0, y: 0, width: 390, height: 720 },
      enabled: true,
      hittable: true,
      visibleToUser: true,
      depth: 0,
    },
    {
      index: 1,
      role: 'static text',
      label: 'Ready',
      rect: { x: 24, y: 32, width: 160, height: 28 },
      enabled: true,
      hittable: true,
      visibleToUser: true,
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      role: 'text field',
      label: 'Email',
      value: state.inputValue,
      rect: INPUT_RECT,
      enabled: true,
      hittable: true,
      visibleToUser: true,
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 3,
      role: 'button',
      label: 'Submit order',
      rect: BUTTON_RECT,
      enabled: true,
      hittable: true,
      visibleToUser: true,
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 4,
      role: 'static text',
      label: state.statusText,
      rect: { x: 24, y: 204, width: 180, height: 28 },
      enabled: true,
      hittable: true,
      visibleToUser: true,
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 5,
      role: 'static text',
      label: state.scrolled ? 'Scrolled section' : 'Below the fold',
      rect: { x: 24, y: 620, width: 180, height: 28 },
      enabled: true,
      hittable: true,
      visibleToUser: true,
      depth: 1,
      parentIndex: 0,
    },
  ];
}

function pointInRect(
  x: number,
  y: number,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
