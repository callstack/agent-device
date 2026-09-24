- Changed (mobile): the post-gesture field that 0.21.13 added as `unsettledGesture` is now
  `postGestureOutcome` (`{ kind, gesture: { action, positionals } }`), with `kind: "unsettled"` for
  a surface that never settled. A re-capture taken at once to recover or widen that tree carries the
  field too. A proven no-effect gesture rides the same field with `kind: "no-effect"`; before, its
  warning reached only `snapshot`. Every interaction that captured the tree (`click`, `press`,
  `fill`, and the other touch and gesture commands) now reports the field in `data` or
  `error.details` with an appended warning, and a failed interaction keeps the disclosure sentences
  in its hint. (#2864)
