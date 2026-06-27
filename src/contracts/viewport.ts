/**
 * Closed result of the `viewport` command. Mirrors the dispatch handler's return
 * EXACTLY (src/core/dispatch.ts `handleViewportCommand`) — `{ width, height }`
 * plus the always-present `successText` message. The generic dispatch path
 * returns this object unchanged (viewport has no Android dialog guard, so no
 * `warning` is ever appended), so the shape is intentionally closed.
 */
export type ViewportCommandResult = {
  width: number;
  height: number;
  message: string;
};
