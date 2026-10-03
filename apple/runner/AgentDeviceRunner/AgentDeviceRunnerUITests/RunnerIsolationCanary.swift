#if AGENT_DEVICE_RUNNER_ISOLATION_CANARY
import Foundation

/// Positive control for `scripts/runner-isolation-diagnostics.ts`. `scripts/build-xcuitest-apple.sh`
/// compiles this file into every runner build it scans, with the runner's own flags, and the scan
/// fails unless it reports a diagnostic on every line marked `isolation-canary`: a Swift release
/// that rewords or regroups one of these diagnostics fails the gate instead of passing it. Nothing
/// calls these functions, and the npm package does not ship this file.
enum RunnerIsolationCanary {
  private final class Counter {
    var value = 0
  }

  static func readsMainOwnedStateOffMain(_ state: RunnerMainOwnedState) {
    DispatchQueue.global().async {
      _ = state.bundleId  // isolation-canary
    }
  }

  static func callsMainActorClosureOffMain(_ work: @escaping @MainActor () -> Void) {
    DispatchQueue.global().async {
      work()  // isolation-canary
    }
  }

  static func dropsMainActor(_ work: @escaping @MainActor () -> Void) -> @Sendable () -> Void {
    work  // isolation-canary
  }

  @MainActor
  static func sendsMainFormedStateOffMain() {
    let counter = Counter()
    DispatchQueue.global().async {
      counter.value += 1  // isolation-canary
    }
  }
}
#endif
