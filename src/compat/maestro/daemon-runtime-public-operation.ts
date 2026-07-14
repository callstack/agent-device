import type { CommandFlags } from '../../core/dispatch.ts';
import type { DaemonRequest } from '../../daemon/types.ts';
import type { Point, Rect } from '../../kernel/snapshot.ts';
import type {
  MaestroDispatchSelector,
  MaestroSinglePointerGestureInput,
} from './runtime-port-types.ts';

export type MaestroClickOptions = Pick<
  CommandFlags,
  'count' | 'intervalMs' | 'doubleTap' | 'holdMs'
>;

export type MaestroPublicOperation =
  | {
      kind: 'launchApp';
      appId?: string;
      relaunch: boolean;
      clearState: boolean;
      launchArgs: string[];
    }
  | { kind: 'stopApp'; appId?: string }
  | { kind: 'openLink'; appId?: string; link: string; prewarmRunner: boolean }
  | { kind: 'typeText'; text: string }
  | { kind: 'clickSelector'; selector: MaestroDispatchSelector; options: MaestroClickOptions }
  | { kind: 'clickPoint'; point: Point; options: MaestroClickOptions }
  | { kind: 'swipe'; gesture: MaestroSinglePointerGestureInput; viewport?: Rect }
  | { kind: 'scroll'; direction: string; durationMs?: number }
  | { kind: 'pressKey'; key: 'back' | 'home' | 'enter' | 'return' | 'dismiss' }
  | { kind: 'screenshot'; path: string }
  | { kind: 'snapshot' };

export type ProjectedMaestroPublicOperation = Pick<DaemonRequest, 'command' | 'positionals'> & {
  input?: Record<string, unknown>;
  flags?: Partial<CommandFlags>;
  internal?: DaemonRequest['internal'];
};

export function projectMaestroPublicOperation(
  operation: MaestroPublicOperation,
): ProjectedMaestroPublicOperation {
  switch (operation.kind) {
    case 'launchApp':
      return {
        command: 'open',
        positionals: operation.appId ? [operation.appId] : [],
        flags: {
          ...(operation.relaunch ? { relaunch: true } : {}),
          ...(operation.clearState ? { clearAppState: true } : {}),
          ...(operation.launchArgs.length > 0 ? { launchArgs: operation.launchArgs } : {}),
        },
      };
    case 'stopApp':
      return { command: 'close', positionals: operation.appId ? [operation.appId] : [] };
    case 'openLink':
      return {
        command: 'open',
        positionals: operation.appId ? [operation.appId, operation.link] : [operation.link],
        ...(operation.prewarmRunner
          ? { flags: { maestro: { prewarmRunnerBeforeOpen: true } } }
          : {}),
      };
    case 'typeText':
      return { command: 'type', positionals: [operation.text] };
    case 'clickSelector':
      return {
        command: 'click',
        positionals: [`${operation.selector.key}=${JSON.stringify(operation.selector.value)}`],
        flags: operation.options,
      };
    case 'clickPoint':
      return {
        command: 'click',
        positionals: [String(operation.point.x), String(operation.point.y)],
        flags: operation.options,
      };
    case 'swipe':
      return {
        command: 'swipe',
        positionals: [],
        input: operation.gesture,
        flags: { postGestureStabilization: false },
        ...(operation.viewport ? { internal: { gestureViewport: operation.viewport } } : {}),
      };
    case 'scroll':
      return {
        command: 'scroll',
        positionals: [operation.direction],
        ...(operation.durationMs === undefined
          ? {}
          : { input: { direction: operation.direction, durationMs: operation.durationMs } }),
        flags: { postGestureStabilization: false },
      };
    case 'pressKey':
      if (operation.key === 'back' || operation.key === 'home') {
        return { command: operation.key, positionals: [] };
      }
      return { command: 'keyboard', positionals: [operation.key] };
    case 'screenshot':
      return { command: 'screenshot', positionals: [operation.path] };
    case 'snapshot':
      return {
        command: 'snapshot',
        positionals: [],
        flags: { noRecord: true },
      };
  }
}
