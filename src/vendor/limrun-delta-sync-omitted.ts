throw new Error(
  'agent-device omits @limrun/xdelta3-wasm, which Limrun loads only from client.syncApp for folder delta sync. No agent-device command reaches it. To use that path, bundle the package in tsdown.config.ts instead of aliasing it here.',
);
