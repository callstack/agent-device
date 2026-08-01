export const BACK_MODES = ['in-app', 'system'] as const;
export type BackMode = (typeof BACK_MODES)[number];
