// Pure math and bookkeeping for following every saved object of a member on the AR screen
// (#351): which anchors are stable, which are due a vision check, when a confirmed object moved,
// and where its off-screen arrow points. It imports no ARKit or UIKit, so
// `tests/TellyArTrackingTests.swift` runs it with plain `swiftc` on a Mac.
import Foundation
import simd

enum Tracking {
  /// A marker shows once its anchor stays within `stableRadius` for this many frames (0.5 s at 60 fps).
  static let stableFrames = 30
  static let stableRadius: Float = 0.05
  /// A vision check that sees the object farther than this from its anchor moves the anchor.
  static let moveThreshold: Float = 0.5
  /// At most one vision check per object in this many seconds.
  static let checkInterval: TimeInterval = 10
  /// Closer than this, the person reached the object: the guide stops asking them to walk.
  static let reachDistance: Float = 0.5
  /// A Vision lock below this confidence is lost; the world anchor guides alone until it locks again.
  static let lockConfidence: Float = 0.3

  /// Where to look for an object that is not on the screen.
  enum Look: Equatable {
    case up, right, down, left, behind

    var words: String {
      switch self {
      case .up: return "Look up"
      case .right: return "Turn right"
      case .down: return "Look down"
      case .left: return "Turn left"
      case .behind: return "Turn around"
      }
    }
  }

  /// The way to turn toward `point`: around when it is within 45 degrees of straight behind,
  /// else the screen side its `bearing` angle falls in.
  static func look(view: simd_float4x4, to point: simd_float3) -> Look {
    let local = view * simd_float4(point, 1)
    if local.z > 0, abs(local.x) < local.z { return .behind }
    let angle = atan2(local.x, local.y)
    switch abs(angle) {
    case ..<(Float.pi / 4): return .up
    case (3 * Float.pi / 4)...: return .down
    default: return angle > 0 ? .right : .left
    }
  }

  /// A box in camera-image pixels (origin top-left) as Vision's normalized box (origin bottom-left).
  static func visionBox(min low: simd_float2, max high: simd_float2, image: simd_float2) -> (origin: simd_float2, size: simd_float2) {
    let size = (high - low) / image
    return (simd_float2(low.x / image.x, 1 - high.y / image.y), size)
  }

  /// The corners of Vision's normalized box as normalized camera-image points (origin top-left).
  static func imageCorners(visionOrigin origin: simd_float2, size: simd_float2) -> (min: simd_float2, max: simd_float2) {
    (simd_float2(origin.x, 1 - origin.y - size.y), simd_float2(origin.x + size.x, 1 - origin.y))
  }

  static func anchorName(_ objectId: String) -> String { "telly-pin-\(objectId)" }

  static func objectId(anchorName name: String?) -> String? {
    guard let name, name.hasPrefix("telly-pin-") else { return nil }
    return String(name.dropFirst("telly-pin-".count))
  }

  /// Whether a vision check at `seen` means the object moved away from its anchor at `anchor`.
  static func moved(from anchor: simd_float3, to seen: simd_float3) -> Bool {
    simd_distance(anchor, seen) > moveThreshold
  }

  /// Where `point` is from the camera. `view` is the camera's view matrix for the screen
  /// orientation (x right, y up, z toward the person). `angle` is the screen direction to turn,
  /// in radians clockwise from screen up; a point straight behind the camera points down.
  static func bearing(view: simd_float4x4, to point: simd_float3) -> (distance: Float, angle: Float, ahead: Bool) {
    let local = view * simd_float4(point, 1)
    let distance = simd_length(simd_make_float3(local))
    let side = simd_length(simd_float2(local.x, local.y))
    let angle = side < 1e-4 ? (local.z > 0 ? Float.pi : 0) : atan2(local.x, local.y)
    return (distance, angle, local.z < 0)
  }

  /// The arrow's center on the edge of a `size` screen (y down), `inset` from every side, in the
  /// direction `angle` from `bearing`.
  static func edgePoint(size: simd_float2, inset: Float, angle: Float) -> simd_float2 {
    let direction = simd_float2(sin(angle), -cos(angle))
    let half = size / 2 - inset
    let reach = min(
      abs(direction.x) < 1e-6 ? .infinity : half.x / abs(direction.x),
      abs(direction.y) < 1e-6 ? .infinity : half.y / abs(direction.y)
    )
    return size / 2 + direction * reach
  }

  /// "keys · 2.1 m"
  static func arrowText(label: String, distance: Float) -> String {
    "\(label) · \(String(format: "%.1f", distance)) m"
  }

  /// The camera-image pixel of a point in the upright (portrait) picture sent to the vision check.
  /// The picture is the camera image turned 90 degrees clockwise, then scaled to `sent`.
  static func imagePixel(upright point: simd_float2, sent: simd_float2, image: simd_float2) -> simd_float2 {
    let scale = image.y / sent.x
    return simd_float2(point.y * scale, image.y - point.x * scale)
  }

  /// The world ray through a camera-image pixel, from the camera's pose and intrinsics at capture.
  static func ray(pixel: simd_float2, intrinsics: simd_float3x3, camera: simd_float4x4) -> (origin: simd_float3, direction: simd_float3) {
    let fx = intrinsics[0][0], fy = intrinsics[1][1]
    let cx = intrinsics[2][0], cy = intrinsics[2][1]
    let local = simd_float4((pixel.x - cx) / fx, -(pixel.y - cy) / fy, -1, 0)
    return (simd_make_float3(camera.columns.3), simd_normalize(simd_make_float3(camera * local)))
  }
}

/// One saved object the screen follows.
struct TrackedObject {
  let objectId: String
  let label: String
  /// The anchor's position, or nil while the session has no anchor for it.
  var position: simd_float3?
  var stableFrom: simd_float3?
  var stableFrames = 0
  /// The marker shows; it stays until relocalization is lost.
  var settled = false
  var lastCheck: TimeInterval = -.infinity

  var stable: Bool { stableFrames >= Tracking.stableFrames }
}

/// Every saved object of the member, keyed by object id.
struct Tracker {
  private(set) var objects: [String: TrackedObject]

  init(_ list: [(objectId: String, label: String)]) {
    var objects: [String: TrackedObject] = [:]
    for item in list where objects[item.objectId] == nil {
      objects[item.objectId] = TrackedObject(objectId: item.objectId, label: item.label)
    }
    self.objects = objects
  }

  /// One frame: `anchors` are the session's anchor positions by anchor name. An object without an
  /// anchor loses its position; one that jumped more than `stableRadius` starts holding still again.
  mutating func update(_ anchors: [String: simd_float3]) {
    for id in objects.keys {
      guard let position = anchors[Tracking.anchorName(id)] else {
        objects[id]?.position = nil
        objects[id]?.stableFrom = nil
        objects[id]?.stableFrames = 0
        continue
      }
      objects[id]?.position = position
      if let start = objects[id]?.stableFrom, simd_distance(start, position) <= Tracking.stableRadius {
        objects[id]?.stableFrames += 1
      } else {
        objects[id]?.stableFrom = position
        objects[id]?.stableFrames = 0
      }
    }
  }

  /// The marker of a stable object on screen shows. Returns whether it just did.
  mutating func settle(_ id: String) -> Bool {
    guard let object = objects[id], !object.settled, object.stable else { return false }
    objects[id]?.settled = true
    return true
  }

  /// Relocalization was lost: every marker hides until its anchor holds still again.
  mutating func lose() {
    for id in objects.keys {
      objects[id]?.settled = false
      objects[id]?.stableFrom = nil
      objects[id]?.stableFrames = 0
    }
  }

  /// The objects with an anchor whose last vision check is `checkInterval` old.
  func due(at now: TimeInterval) -> [String] {
    objects.values
      .filter { $0.position != nil && now - $0.lastCheck >= Tracking.checkInterval }
      .map(\.objectId)
      .sorted()
  }

  mutating func checked(_ ids: [String], at now: TimeInterval) {
    for id in ids { objects[id]?.lastCheck = now }
  }
}
