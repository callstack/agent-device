// The npm package ships this one file and nothing else under the test targets (see `files` in
// package.json). SwiftPM refuses to load a package whose declared test target has no sources, so
// the install-time `swift build` of the packed tree needs a source here; the real tests for this
// target live beside it and are excluded from the pack.
import XCTest

final class AgentDeviceMacOSInputPackStubTests: XCTestCase {}
