struct SelectorCandidateFacts {
  let isHittable: Bool
  let hasTappableFrame: Bool
  let containsExpectedPoint: Bool

  init(
    isHittable: Bool,
    hasTappableFrame: Bool,
    containsExpectedPoint: Bool = true
  ) {
    self.isHittable = isHittable
    self.hasTappableFrame = hasTappableFrame
    self.containsExpectedPoint = containsExpectedPoint
  }
}

enum DirectSelectorCandidateDecision: Equatable {
  case noMatch
  case selected(index: Int, usedNonHittableFallback: Bool)
  case ambiguous
}

/// How many raw exact matches a dispatch may discard before hittability is
/// allowed to pick a winner. The two rows differ because the cost of guessing
/// wrong differs, not because the matching differs.
enum DirectSelectorRawMatchPolicy: Equatable {
  /// Mutations fail closed: every raw exact match counts, so a hittable
  /// element can never silently win over a same-selector duplicate the caller
  /// never saw and act on the wrong one.
  case rejectDistinctMatches
  /// Reads prefer the single hittable match and ignore non-hittable
  /// same-selector duplicates. A read has no side effect to guard, and
  /// `querySelector` backs `get`/`is`/`wait` — failing those closed turns a
  /// decorative duplicate into an error where the reader previously got its
  /// answer.
  case preferHittableMatch
}

/// Normal direct selector mutations count every raw exact match before
/// hittability can choose a winner. Reads keep the hittable-preference rule,
/// and Maestro's explicitly requested coordinate fallback keeps its
/// point-filtered compatibility behavior.
func classifyDirectSelectorCandidates(
  _ candidates: [SelectorCandidateFacts],
  allowNonHittableFallback: Bool,
  filtersByExpectedPoint: Bool = false,
  rawMatchPolicy: DirectSelectorRawMatchPolicy = .rejectDistinctMatches
) -> DirectSelectorCandidateDecision {
  let eligible = candidates.indices.filter { index in
    !filtersByExpectedPoint || candidates[index].containsExpectedPoint
  }

  if !allowNonHittableFallback && rawMatchPolicy == .rejectDistinctMatches {
    guard eligible.count <= 1 else { return .ambiguous }
    guard let index = eligible.first, candidates[index].isHittable else { return .noMatch }
    return .selected(index: index, usedNonHittableFallback: false)
  }

  var hittableIndex: Int?
  var fallbackIndex: Int?
  for index in eligible {
    let candidate = candidates[index]
    if candidate.isHittable {
      guard hittableIndex == nil else { return .ambiguous }
      hittableIndex = index
    } else if allowNonHittableFallback && candidate.hasTappableFrame {
      guard fallbackIndex == nil else { return .ambiguous }
      fallbackIndex = index
    }
  }
  if let hittableIndex {
    return .selected(index: hittableIndex, usedNonHittableFallback: false)
  }
  if let fallbackIndex {
    return .selected(index: fallbackIndex, usedNonHittableFallback: true)
  }
  return .noMatch
}
