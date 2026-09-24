- Fixed (mobile): a read taken right after a `scroll`, `swipe`, or `gesture swipe` no longer reports
  a definite miss when the surface never settled. When post-gesture stabilization ran out of budget
  on a surface still moving, `is visible` answered a plain `selector_not_found` and `is absent`
  passed. The capture now carries `postGestureOutcome` (`{ kind, gesture: { action, positionals } }`)
  with `kind: "unsettled"`, and so does a re-capture taken at once to recover or widen it. A proven
  no-effect gesture rides the same field with `kind: "no-effect"`; before, its warning reached only
  `snapshot`. `is`, `get`, `find`, `wait`, and every interaction that captured it (`click`, `press`,
  `fill`, and the other touch and gesture commands) report the field in `data` or `error.details`
  with an appended warning; `snapshot` appends the warning. `is absent` refuses an unsettled capture
  with `observation: "unsettled"`, `wait absent` keeps polling, and the next read captures afresh.
  A failed read also carries `targetActivation` in `error.details`, and a failed interaction now
  keeps the disclosure sentences in its hint.
