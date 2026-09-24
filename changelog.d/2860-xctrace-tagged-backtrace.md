- Fixed (ios): `perf cpu profile report --kind xctrace` on Xcode 27 no longer fails with
  `Apple xctrace CPU report contained no samples` on a trace that holds thousands of samples. Xcode
  27 exports each `time-profile` sample stack as `<tagged-backtrace>` instead of `<backtrace>`, and
  the parser read only the old element, so every row resolved no stack at all. Both spellings now
  parse through the same `id`/`ref` resolution, so a profile recorded with an older Xcode reports
  what it did before. (#2860)
