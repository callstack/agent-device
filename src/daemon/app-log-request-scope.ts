// Dedicated lazy boundary for request-scoped app-log provider composition, kept
// separate from the eager `app-log.ts` module so its dynamic import stays effective.
export { withAppLogProvider } from './app-log.ts';
