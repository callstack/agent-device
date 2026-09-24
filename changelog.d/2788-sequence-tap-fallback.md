- Fixed (ios): a synthesized tap step inside a runner `sequence` (for example `press x y --count N`)
  now follows the standalone tap's policy instead of its own. When accessibility is unavailable or no
  app window resolves, the step now falls back to an XCTest coordinate tap instead of failing the
  step with `UNSUPPORTED_OPERATION`. One helper now owns the synthesize-then-fallback decision at
  every synthesized tap site (#2788).
