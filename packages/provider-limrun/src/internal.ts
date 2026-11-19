/**
 * The seam core composes Limrun through while the provider is still built in. Nothing here loads the
 * Limrun SDK: the runtime, the platform adapters, and the connection verification each load when
 * their own path asks for them. The root entry keeps the SDK-side surface.
 */
export { limrunPlugin } from './plugin.ts';
export {
  limrunInstanceVariables,
  limrunPlatformForLeaseBackend,
  readLimrunCredentials,
} from './credentials.ts';
