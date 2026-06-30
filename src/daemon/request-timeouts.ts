export const DAEMON_REQUEST_TIMEOUT_MS = 90_000;
export const PREPARE_REQUEST_TIMEOUT_MS = 240_000;

// Keep this above the longest platform install subprocess timeout so the client
// envelope does not abort a still-progressing device install first.
export const INSTALL_REQUEST_TIMEOUT_MS = 180_000;
