// Vocabulary for the platform-plugin provider facet.
//
// `core/platform-plugin/plugin.ts` declares which daemon provider resolvers a platform
// family gates. The daemon owns the resolvers themselves and asserts at compile time, in
// `daemon/request-platform-providers.ts`, that every key named here is a real resolver —
// so the facet can never name a resolver the daemon does not compose.

/**
 * The request provider resolvers whose application is PLATFORM-GATED — each ran behind
 * a hand `device.platform === …` predicate inside its descriptor's `resolve`. The
 * PlatformPlugin `providers` facet (issue #974) declares, per family, which of these
 * apply to that family's devices (data-only: a plain string list, type-only in the
 * plugin), and `platformGatedResolverApplies` routes the gate through it. The daemon
 * still OWNS the resolver invocation, wrapper composition, and request-scope
 * concurrency isolation — only the platform GATE moved to data.
 *
 * App-log and screen-recording transports are deliberately ABSENT: they carry no
 * platform gate (they apply on every platform), so they stay ungated in the daemon and
 * are not part of the facet.
 */
export type PlatformGatedProviderResolverKey =
  | 'androidAdbProvider'
  | 'appleRunnerProvider'
  | 'appleToolProvider'
  | 'vegaToolProvider'
  | 'linuxToolProvider'
  | 'webProvider';
