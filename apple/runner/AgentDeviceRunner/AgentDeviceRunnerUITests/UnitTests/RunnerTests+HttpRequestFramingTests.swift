import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private static let framingToken = String(repeating: "t", count: 32)

  private func framingHead(_ lines: [String], body: String = "") -> Data {
    Data((lines + ["", body]).joined(separator: "\r\n").utf8)
  }

  private func admit(_ lines: [String], body: String = "") -> RunnerHttpHeadVerdict {
    RunnerHttpRequestFraming.admitHead(framingHead(lines, body: body), token: framingListenerToken)
  }

  private var framingListenerToken: RunnerListenerToken {
    RunnerListenerToken(Self.framingToken)!
  }

  private var authenticatedPost: [String] {
    ["POST /command HTTP/1.1", "X-Agent-Device-Runner-Token: \(Self.framingToken)"]
  }

  func testHttpFramingAdmitsAnAuthenticatedCommandPost() {
    let head = framingHead(authenticatedPost + ["Content-Length: 2"], body: "{}")
    XCTAssertEqual(
      admit(authenticatedPost + ["Content-Length: 2"], body: "{}"),
      .admitted(RunnerHttpAdmittedHead(bodyOffset: head.count - 2, contentLength: 2, keepsConnectionAlive: true))
    )
  }

  func testHttpFramingResolvesConnectionPersistence() {
    let cases: [(String, [String], Bool)] = [
      ("HTTP/1.1", [], true),
      ("HTTP/1.1", ["Connection: close"], false),
      ("HTTP/1.1", ["Connection: upgrade, CLOSE"], false),
      ("HTTP/1.1", ["Connection: keep-alive", "connection: Close"], false),
      ("HTTP/1.0", [], false),
      ("HTTP/1.0", ["Connection: Keep-Alive"], true),
      ("HTTP/1.0", ["Connection: keep-alive, close"], false),
    ]
    for (version, connection, expected) in cases {
      let verdict = admit(["POST /command \(version)", authenticatedPost[1], "Content-Length: 0"] + connection)
      guard case .admitted(let head) = verdict else {
        XCTFail("unexpected refusal: \(verdict)")
        continue
      }
      XCTAssertEqual(head.keepsConnectionAlive, expected, "\(version) \(connection)")
    }
  }

  func testHttpFramingWaitsForTheWholeHead() {
    let partial = Data("POST /command HTTP/1.1\r\nContent-Length: 2\r\n".utf8)
    XCTAssertEqual(
      RunnerHttpRequestFraming.admitHead(partial, token: framingListenerToken),
      .incomplete
    )
  }

  func testHttpFramingChecksTheTokenBeforeRoutingOrLength() {
    XCTAssertEqual(
      admit(["GET /other HTTP/1.1", "Content-Length: -1"]),
      .rejected(.unauthorized)
    )
    XCTAssertEqual(
      admit(["POST /command HTTP/1.1", "X-Agent-Device-Runner-Token: wrong", "Content-Length: 2"]),
      .rejected(.unauthorized)
    )
    XCTAssertEqual(
      admit(authenticatedPost + [authenticatedPost[1], "Content-Length: 2"]),
      .rejected(.unauthorized)
    )
  }

  func testHttpFramingRefusesEveryRouteButPostCommand() {
    XCTAssertEqual(
      admit(["GET /command HTTP/1.1", authenticatedPost[1], "Content-Length: 0"]),
      .rejected(.methodNotAllowed)
    )
    XCTAssertEqual(
      admit(["POST /status HTTP/1.1", authenticatedPost[1], "Content-Length: 0"]),
      .rejected(.notFound)
    )
  }

  func testHttpFramingRefusesAmbiguousOrUnboundedBodyLengths() {
    let cases: [(String, [String], RunnerHttpRequestRejection)] = [
      ("missing", [], .lengthRequired),
      ("negative", ["Content-Length: -5"], .malformed("Content-Length")),
      ("signed", ["Content-Length: +5"], .malformed("Content-Length")),
      ("non-numeric", ["Content-Length: 1e3"], .malformed("Content-Length")),
      ("empty", ["Content-Length:"], .malformed("Content-Length")),
      ("duplicate", ["Content-Length: 2", "Content-Length: 2"], .lengthRequired),
      ("over limit", ["Content-Length: \(RunnerHttpRequestFraming.maxBodyBytes + 1)"], .bodyTooLarge),
      ("overflow", ["Content-Length: 99999999999999999999999"], .bodyTooLarge),
      ("chunked", ["Transfer-Encoding: chunked", "Content-Length: 2"], .transferEncodingUnsupported),
    ]
    for (name, lengthLines, expected) in cases {
      XCTAssertEqual(admit(authenticatedPost + lengthLines), .rejected(expected), name)
    }
  }

  func testHttpFramingFindsATerminatorSplitAcrossChunks() {
    let request = framingHead(authenticatedPost + ["Content-Length: 0"])
    for split in 1..<request.count {
      let first = request.prefix(split)
      let firstVerdict = RunnerHttpRequestFraming.admitHead(Data(first), token: framingListenerToken)
      guard firstVerdict == .incomplete else { continue }
      XCTAssertEqual(
        RunnerHttpRequestFraming.admitHead(request, token: framingListenerToken, alreadyScanned: split),
        .admitted(RunnerHttpAdmittedHead(bodyOffset: request.count, contentLength: 0, keepsConnectionAlive: true)),
        "split at \(split)"
      )
    }
  }

  func testHttpFramingBoundsTheHeadBeforeItIsComplete() {
    let padding = String(repeating: "a", count: RunnerHttpRequestFraming.maxHeadBytes)
    let oversized = Data(("POST /command HTTP/1.1\r\nX-Pad: " + padding).utf8)
    XCTAssertEqual(
      RunnerHttpRequestFraming.admitHead(oversized, token: framingListenerToken),
      .rejected(.headTooLarge)
    )
  }

  func testHttpFramingRefusesMalformedHeads() {
    XCTAssertEqual(admit(["POST /command"]), .rejected(.malformed("request line")))
    XCTAssertEqual(
      admit(authenticatedPost + [" folded: value", "Content-Length: 0"]),
      .rejected(.malformed("header name"))
    )
    XCTAssertEqual(
      admit(authenticatedPost + ["no colon", "Content-Length: 0"]),
      .rejected(.malformed("header line"))
    )
  }
}
#endif
