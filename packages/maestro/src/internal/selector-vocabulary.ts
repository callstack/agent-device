import type { MaestroSelectorMap } from './program-ir.ts';

export const MAESTRO_BASE_SELECTOR_KEYS = ['id', 'text', 'enabled', 'selected'] as const;
export const MAESTRO_TAP_SELECTOR_KEYS = [...MAESTRO_BASE_SELECTOR_KEYS, 'label'] as const;
export const MAESTRO_TEXT_SELECTOR_KEYS = ['id', 'text', 'label'] as const;
export const MAESTRO_STATE_SELECTOR_KEYS = ['enabled', 'selected'] as const;

export type MaestroSelectorKey = keyof MaestroSelectorMap;
