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

/// Normal direct selector mutations count every raw exact match before
/// hittability can choose a winner. Maestro's explicitly requested coordinate
/// fallback keeps its point-filtered compatibility behavior.
func classifyDirectSelectorCandidates(
  _ candidates: [SelectorCandidateFacts],
  allowNonHittableFallback: Bool,
  filtersByExpectedPoint: Bool = false
) -> DirectSelectorCandidateDecision {
  let eligible = candidates.indices.filter { index in
    !filtersByExpectedPoint || candidates[index].containsExpectedPoint
  }

  if !allowNonHittableFallback {
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
    } else if candidate.hasTappableFrame {
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
