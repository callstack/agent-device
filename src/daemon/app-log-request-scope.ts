// Isolates request-scope provider composition behind its dynamic import.
// The shared app-log implementation remains eager for observability and teardown.
export { withAppLogProvider } from './app-log.ts';
