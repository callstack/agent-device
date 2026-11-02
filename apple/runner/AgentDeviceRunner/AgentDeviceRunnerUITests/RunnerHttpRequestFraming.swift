import Foundation

/// Why the listener refused a request before reading its body. Each refusal answers on its own
/// connection and leaves the listener serving.
enum RunnerHttpRequestRejection: Equatable {
  case malformed(String)
  case headTooLarge
  case unauthorized
  case transferEncodingUnsupported
  case lengthRequired
  case bodyTooLarge
  case methodNotAllowed
  case notFound
  case timedOut

  var status: Int {
    switch self {
    case .malformed, .transferEncodingUnsupported: return 400
    case .unauthorized: return 401
    case .notFound: return 404
    case .methodNotAllowed: return 405
    case .timedOut: return 408
    case .lengthRequired: return 411
    case .bodyTooLarge: return 413
    case .headTooLarge: return 431
    }
  }

  var code: String {
    self == .unauthorized ? "UNAUTHORIZED" : "INVALID_ARGS"
  }

  var message: String {
    switch self {
    case .malformed(let part): return "runner request is malformed: \(part)"
    case .headTooLarge:
      return "runner request head exceeds \(RunnerHttpRequestFraming.maxHeadBytes) bytes"
    case .unauthorized: return "runner request is missing a valid listener token"
    case .transferEncodingUnsupported: return "runner requests must not use Transfer-Encoding"
    case .lengthRequired: return "runner requests must declare one Content-Length"
    case .bodyTooLarge:
      return "runner request body exceeds \(RunnerHttpRequestFraming.maxBodyBytes) bytes"
    case .methodNotAllowed: return "runner accepts only POST"
    case .notFound: return "runner serves only \(RunnerHttpRequestFraming.commandPath)"
    case .timedOut: return "runner request did not arrive before its deadline"
    }
  }
}

/// Where an admitted request's body sits in the buffer that holds its head.
struct RunnerHttpAdmittedHead: Equatable {
  let bodyOffset: Int
  let contentLength: Int
  let keepsConnectionAlive: Bool
}

enum RunnerHttpHeadVerdict: Equatable {
  case incomplete
  case admitted(RunnerHttpAdmittedHead)
  case rejected(RunnerHttpRequestRejection)
}

/// Admits one request head. The token is checked before routing and length, so a peer without it
/// learns nothing about the protocol and no body is ever read for it.
enum RunnerHttpRequestFraming {
  static let commandPath = "/command"
  static let maxHeadBytes = 16 * 1024
  static let maxBodyBytes = 2 * 1024 * 1024
  private static let headTerminator = Data("\r\n\r\n".utf8)

  /// `alreadyScanned` bytes held no terminator on an earlier call, so the search resumes just before
  /// them instead of rescanning a head that arrives one byte at a time.
  static func admitHead(
    _ buffer: Data,
    token: RunnerListenerToken,
    alreadyScanned: Int = 0
  ) -> RunnerHttpHeadVerdict {
    let searchStart = buffer.startIndex + max(0, alreadyScanned - (headTerminator.count - 1))
    guard let terminator = buffer.range(of: headTerminator, in: searchStart..<buffer.endIndex) else {
      return buffer.count > maxHeadBytes ? .rejected(.headTooLarge) : .incomplete
    }
    if terminator.lowerBound - buffer.startIndex > maxHeadBytes { return .rejected(.headTooLarge) }
    guard
      let head = String(data: buffer[buffer.startIndex..<terminator.lowerBound], encoding: .utf8)
    else {
      return .rejected(.malformed("head is not UTF-8"))
    }
    var lines = head.components(separatedBy: "\r\n")
    let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: false)
    guard requestLine.count == 3, requestLine[2] == "HTTP/1.1" || requestLine[2] == "HTTP/1.0" else {
      return .rejected(.malformed("request line"))
    }
    var headers: [String: [String]] = [:]
    for line in lines {
      guard let colon = line.firstIndex(of: ":") else {
        return .rejected(.malformed("header line"))
      }
      let name = line[line.startIndex..<colon]
      guard !name.isEmpty, name.allSatisfy(isHeaderNameCharacter) else {
        return .rejected(.malformed("header name"))
      }
      let value = line[line.index(after: colon)...].trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
      headers[name.lowercased(), default: []].append(value)
    }

    guard let presented = headers[RunnerListenerToken.requestHeaderName], presented.count == 1,
      token.matches(presented[0])
    else {
      return .rejected(.unauthorized)
    }
    guard requestLine[0] == "POST" else { return .rejected(.methodNotAllowed) }
    guard requestLine[1] == Substring(commandPath) else { return .rejected(.notFound) }
    if headers["transfer-encoding"] != nil { return .rejected(.transferEncodingUnsupported) }
    guard let lengths = headers["content-length"], lengths.count == 1 else {
      return .rejected(.lengthRequired)
    }
    let declared = lengths[0]
    guard !declared.isEmpty, declared.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else {
      return .rejected(.malformed("Content-Length"))
    }
    guard declared.utf8.count <= 10, let contentLength = Int(declared), contentLength <= maxBodyBytes
    else {
      return .rejected(.bodyTooLarge)
    }
    let connectionOptions = (headers["connection"] ?? []).flatMap {
      $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
    }
    let keepsConnectionAlive = !connectionOptions.contains("close")
      && (requestLine[2] == "HTTP/1.1" || connectionOptions.contains("keep-alive"))
    return .admitted(
      RunnerHttpAdmittedHead(
        bodyOffset: terminator.upperBound - buffer.startIndex,
        contentLength: contentLength,
        keepsConnectionAlive: keepsConnectionAlive
      )
    )
  }

  private static func isHeaderNameCharacter(_ character: Character) -> Bool {
    guard let ascii = character.asciiValue else { return false }
    switch ascii {
    case 0x30...0x39, 0x41...0x5A, 0x61...0x7A: return true
    default: return "!#$%&'*+-.^_`|~".utf8.contains(ascii)
    }
  }
}
