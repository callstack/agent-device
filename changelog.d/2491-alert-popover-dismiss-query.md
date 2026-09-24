- Fixed (ios): `alert get`, `accept`, or `dismiss` with no alert on screen no longer reads every
  element of the app to look for a popover's dismiss region. That walk cost one XCTest round trip
  per element, plus XCTest's retry cycle for each element that vanished mid-walk. On a loading
  WebView it outran the 10 s alert budget and kept the runner's main thread busy for more than 30 s
  after the command failed, so later commands failed with `RUNNER_BUSY`. The dismiss region is now
  found with one predicate query per window set. (#2491)
