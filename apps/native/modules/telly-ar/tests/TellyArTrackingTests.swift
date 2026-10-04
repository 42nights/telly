// Checks ios/TellyArTracking.swift without Xcode or a device (#351). On a Mac:
//   swiftc -parse-as-library apps/native/modules/telly-ar/ios/TellyArTracking.swift \
//     apps/native/modules/telly-ar/tests/TellyArTrackingTests.swift -o /tmp/ar-tracking && /tmp/ar-tracking
// It lives outside ios/, so the app's pod does not build it.
import Foundation
import simd

private var failures = 0

private func check(_ ok: Bool, _ what: String, line: Int = #line) {
  if !ok {
    failures += 1
    print("FAIL line \(line): \(what)")
  }
}

private func near(_ a: Float, _ b: Float, _ tolerance: Float = 1e-3) -> Bool { abs(a - b) <= tolerance }

/// A camera at `position` that turned `yaw` radians to the left (counterclockwise seen from above).
private func camera(at position: simd_float3, yaw: Float) -> simd_float4x4 {
  var pose = simd_float4x4(simd_quatf(angle: yaw, axis: simd_float3(0, 1, 0)))
  pose.columns.3 = simd_float4(position, 1)
  return pose
}

private func view(_ pose: simd_float4x4) -> simd_float4x4 { pose.inverse }

private func arrowMath() {
  let origin = camera(at: simd_float3(0, 1.5, 0), yaw: 0)

  // Straight ahead, 2 m: on the screen, arrow up.
  var b = Tracking.bearing(view: view(origin), to: simd_float3(0, 1.5, -2))
  check(b.ahead && near(b.distance, 2) && near(b.angle, 0), "ahead: \(b)")

  // 2.1 m to the right: turn right.
  b = Tracking.bearing(view: view(origin), to: simd_float3(2.1, 1.5, 0))
  check(near(b.distance, 2.1) && near(b.angle, .pi / 2), "right: \(b)")
  check(Tracking.arrowText(label: "keys", distance: b.distance) == "keys · 2.1 m", "text")

  // Behind and a little to the left: not ahead, and the arrow points left, not mirrored right.
  b = Tracking.bearing(view: view(origin), to: simd_float3(-0.5, 1.5, 3))
  check(!b.ahead && near(b.angle, -.pi / 2), "behind left: \(b)")

  // Straight behind: the arrow points down.
  b = Tracking.bearing(view: view(origin), to: simd_float3(0, 1.5, 3))
  check(!b.ahead && near(abs(b.angle), .pi) && near(b.distance, 3), "behind: \(b)")

  // Below the camera: down.
  b = Tracking.bearing(view: view(origin), to: simd_float3(0, 0.5, -0.0))
  check(near(abs(b.angle), .pi), "below: \(b)")

  // The person turns 90 degrees left: the object that was ahead is now on the right.
  let turned = camera(at: simd_float3(0, 1.5, 0), yaw: .pi / 2)
  b = Tracking.bearing(view: view(turned), to: simd_float3(0, 1.5, -2))
  check(near(b.angle, .pi / 2) && near(b.distance, 2), "turned: \(b)")

  // Walking changes the distance every frame.
  let walked = camera(at: simd_float3(0, 1.5, -1), yaw: 0)
  b = Tracking.bearing(view: view(walked), to: simd_float3(0, 1.5, -2))
  check(near(b.distance, 1), "walked: \(b)")

  // Edge points stay inside the inset screen and on its edge.
  let size = simd_float2(390, 844)
  var p = Tracking.edgePoint(size: size, inset: 40, angle: .pi / 2)
  check(near(p.x, 350) && near(p.y, 422), "edge right: \(p)")
  p = Tracking.edgePoint(size: size, inset: 40, angle: 0)
  check(near(p.x, 195) && near(p.y, 40), "edge up: \(p)")
  p = Tracking.edgePoint(size: size, inset: 40, angle: .pi)
  check(near(p.x, 195) && near(p.y, 804), "edge down: \(p)")
  p = Tracking.edgePoint(size: size, inset: 40, angle: .pi / 4)
  check(near(p.x, 350) && near(p.y, 267), "edge diagonal hits the side first: \(p)")
}

private func rayMath() {
  // A 1920 × 1440 camera image, sent upright at 960 × 1280.
  let image = simd_float2(1920, 1440)
  let sent = simd_float2(960, 1280)
  // The upright picture's top-left is the image's bottom-left; its center is the image's center.
  var px = Tracking.imagePixel(upright: simd_float2(0, 0), sent: sent, image: image)
  check(near(px.x, 0) && near(px.y, 1440), "corner: \(px)")
  px = Tracking.imagePixel(upright: simd_float2(480, 640), sent: sent, image: image)
  check(near(px.x, 960) && near(px.y, 720), "center: \(px)")

  // A pinhole camera at the origin, looking down -z: the center pixel looks straight ahead.
  let intrinsics = simd_float3x3(columns: (
    simd_float3(1500, 0, 0), simd_float3(0, 1500, 0), simd_float3(960, 720, 1)
  ))
  var ray = Tracking.ray(pixel: simd_float2(960, 720), intrinsics: intrinsics, camera: matrix_identity_float4x4)
  check(near(ray.direction.z, -1) && near(ray.origin.x, 0), "center ray: \(ray)")
  // 1500 px right of center is 45 degrees to the camera's +x.
  ray = Tracking.ray(pixel: simd_float2(2460, 720), intrinsics: intrinsics, camera: matrix_identity_float4x4)
  check(near(ray.direction.x, sqrt(0.5)) && near(ray.direction.z, -sqrt(0.5)), "side ray: \(ray)")
  // Image rows grow downward; the camera's y grows upward.
  ray = Tracking.ray(pixel: simd_float2(960, 0), intrinsics: intrinsics, camera: matrix_identity_float4x4)
  check(ray.direction.y > 0, "top row looks up: \(ray)")
}

private func lookAndLock() {
  let origin = camera(at: simd_float3(0, 1.5, 0), yaw: 0)
  let v = view(origin)
  check(Tracking.look(view: v, to: simd_float3(2, 1.5, -1)) == .right, "right")
  check(Tracking.look(view: v, to: simd_float3(-2, 1.5, -1)) == .left, "left")
  check(Tracking.look(view: v, to: simd_float3(0, 3, -1)) == .up, "up")
  check(Tracking.look(view: v, to: simd_float3(0.2, 0.2, -1)) == .down, "down, on the floor in front")
  check(Tracking.look(view: v, to: simd_float3(0.5, 1.5, 2)) == .behind, "behind, a little right")
  // Behind but far to the side: turning right is the short way.
  check(Tracking.look(view: v, to: simd_float3(3, 1.5, 1)) == .right, "behind right")
  check(Tracking.look(view: v, to: simd_float3(0, 1.5, 2)).words == "Turn around", "words")

  // A 1920 × 1440 image: a box in pixels to Vision's flipped normalized box, and back.
  let image = simd_float2(1920, 1440)
  let box = Tracking.visionBox(min: simd_float2(480, 360), max: simd_float2(960, 1080), image: image)
  check(near(box.origin.x, 0.25) && near(box.origin.y, 0.25) && near(box.size.x, 0.25) && near(box.size.y, 0.5), "vision box: \(box)")
  let corners = Tracking.imageCorners(visionOrigin: box.origin, size: box.size)
  check(near(corners.min.x * image.x, 480) && near(corners.min.y * image.y, 360), "back min: \(corners)")
  check(near(corners.max.x * image.x, 960) && near(corners.max.y * image.y, 1080), "back max: \(corners)")
  // A box at the top of the image sits at the top of Vision's space (y near 1).
  let top = Tracking.visionBox(min: simd_float2(0, 0), max: simd_float2(192, 144), image: image)
  check(near(top.origin.y, 0.9) && near(top.origin.y + top.size.y, 1), "top box: \(top)")
}

private func moveThreshold() {
  let anchor = simd_float3(1, 0.8, -2)
  check(!Tracking.moved(from: anchor, to: anchor + simd_float3(0.3, 0, 0.3)), "0.42 m is the same spot")
  check(!Tracking.moved(from: anchor, to: anchor + simd_float3(0.5, 0, 0)), "exactly 0.5 m is the same spot")
  check(Tracking.moved(from: anchor, to: anchor + simd_float3(0.4, 0, 0.4)), "0.57 m moved")
  check(Tracking.moved(from: anchor, to: anchor + simd_float3(0, 2, 0)), "2 m up moved")
}

private func bookkeeping() {
  check(Tracking.objectId(anchorName: "telly-pin-42") == "42", "anchor name")
  check(Tracking.objectId(anchorName: "plane") == nil && Tracking.objectId(anchorName: nil) == nil, "other anchors")

  var tracker = Tracker([("k", "keys"), ("w", "wallet"), ("g", "glasses"), ("k", "duplicate")])
  check(tracker.objects.count == 3 && tracker.objects["k"]?.label == "keys", "one entry per object")

  let keys = simd_float3(0, 0.8, -1), wallet = simd_float3(2, 0.4, 1)
  let anchors = [Tracking.anchorName("k"): keys, Tracking.anchorName("w"): wallet, "telly-pin-forgotten": keys]
  tracker.update(anchors)
  check(tracker.objects["g"]?.position == nil, "glasses are in another room")
  check(tracker.objects.count == 3, "an unknown anchor is not followed")
  check(tracker.due(at: 0) == ["k", "w"], "only objects with an anchor are due: \(tracker.due(at: 0))")

  // Holding still for 30 frames settles each marker once, independently.
  check(!tracker.settle("k"), "not stable yet")
  for _ in 0..<Tracking.stableFrames { tracker.update(anchors) }
  check(tracker.settle("k") && !tracker.settle("k"), "keys settle once")
  check(tracker.objects["w"]?.stable == true && tracker.objects["w"]?.settled == false, "wallet waits for its own settle")

  // ARKit nudges an anchor by 3 cm: still stable. A jump of 30 cm starts over, the marker stays.
  tracker.update([Tracking.anchorName("k"): keys + simd_float3(0.03, 0, 0), Tracking.anchorName("w"): wallet])
  check(tracker.objects["k"]?.stable == true, "3 cm keeps stable")
  tracker.update([Tracking.anchorName("k"): keys + simd_float3(0.3, 0, 0), Tracking.anchorName("w"): wallet])
  check(tracker.objects["k"]?.stable == false && tracker.objects["k"]?.settled == true, "a jump restarts stability only")

  // Rate limit: one check per object per 10 s.
  tracker.checked(["k"], at: 100)
  check(tracker.due(at: 105) == ["w"], "keys checked 5 s ago: \(tracker.due(at: 105))")
  check(tracker.due(at: 110) == ["k", "w"], "10 s later keys are due again")

  // Relocalization lost: every marker hides and must hold still again; positions stay.
  tracker.lose()
  check(tracker.objects.values.allSatisfy { !$0.settled && !$0.stable }, "lost clears markers")
  check(tracker.objects["k"]?.position != nil, "anchors stay")

  // An anchor that leaves the session loses its position and is not due.
  tracker.update([Tracking.anchorName("w"): wallet])
  check(tracker.objects["k"]?.position == nil && tracker.due(at: 1000) == ["w"], "removed anchor")
}

@main
struct TellyArTrackingTests {
  static func main() {
    arrowMath()
    rayMath()
    moveThreshold()
    lookAndLock()
    bookkeeping()
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
    print("TellyArTracking: all checks passed")
  }
}
