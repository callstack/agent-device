import type { DisplayServer } from './display.ts';

export type InputTool = 'xdotool' | 'ydotool';

/** The input tool one provider resolved, tagged with the display decision it resolved for. */
export type LinuxInputSelection = { tool: InputTool; display: DisplayServer };
