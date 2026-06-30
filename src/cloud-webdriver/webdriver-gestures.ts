import { centerOfRect } from '../kernel/snapshot.ts';
import type { ScrollDirection } from '../core/scroll-gesture.ts';
import type { W3CActionSequence } from './webdriver-client.ts';

export function touchPointer(name: string, actions: Record<string, unknown>[]): W3CActionSequence {
  return {
    type: 'pointer',
    id: name,
    parameters: { pointerType: 'touch' },
    actions,
  };
}

export function scrollStart(
  direction: ScrollDirection,
  distance: number,
): { x: number; y: number } {
  const rect = { x: 0, y: 0, width: 400, height: 800 };
  const center = centerOfRect(rect);
  switch (direction) {
    case 'up':
      return { x: center.x, y: center.y + Math.round(distance / 2) };
    case 'down':
      return { x: center.x, y: center.y - Math.round(distance / 2) };
    case 'left':
      return { x: center.x + Math.round(distance / 2), y: center.y };
    case 'right':
      return { x: center.x - Math.round(distance / 2), y: center.y };
  }
}

export function scrollEnd(direction: ScrollDirection, distance: number): { x: number; y: number } {
  const start = scrollStart(direction, distance);
  switch (direction) {
    case 'up':
      return { ...start, y: start.y - distance };
    case 'down':
      return { ...start, y: start.y + distance };
    case 'left':
      return { ...start, x: start.x - distance };
    case 'right':
      return { ...start, x: start.x + distance };
  }
}
