// Lazy entry for request-scoped app-log provider composition.
//
// `request-platform-providers` composes every provider wrapper behind a dynamic import so
// provider machinery stays out of the eager daemon graph. `app-log.ts` cannot be that lazy
// boundary itself: `session-teardown`/`session-observability` import it statically for the
// eager start/stop/doctor paths, so importing it dynamically was ineffective (the module is
// already in the daemon chunk). This re-export is the dedicated lazy boundary for the
// request-scope wrapper, keeping the dynamic import effective without changing where the
// eager app-log code lives.
export { withAppLogProvider } from './app-log.ts';
