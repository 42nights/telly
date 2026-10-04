// The phone AR pin for the object finder. The web app asks through the WebView bridge
// (app/(drawer)/web.tsx, lib/ar-bridge.ts); this module opens a full-screen ARKit screen and
// answers with the contract's reply shapes (minus `requestId`, which the shell adds).
// While the screen runs, it follows every saved object of the member (#351). Its messages to the
// web app (a camera frame to check, an object that moved) wait in a queue that the web app reads
// with `watch`, one at a time, so the shell needs no push channel.
// The module shape follows the expo-modules-core examples (MIT, 650 Industries). The world map
// save and load follow Apple's "Saving and Loading World Data" sample (Apple Sample Code License):
// archive with NSKeyedArchiver, load with `initialWorldMap`.
import ARKit
import AVFoundation
import ExpoModulesCore

func arError(_ code: String, _ message: String) -> [String: Any] {
  return ["type": "ar.error", "code": code, "message": message]
}

enum WorldMapCodec {
  // NSKeyedArchiver, then zlib, then base64 (the contract's `worldMap`).
  static func encode(_ map: ARWorldMap) throws -> Data {
    let archived = try NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true)
    return try (archived as NSData).compressed(using: .zlib) as Data
  }

  static func decode(_ base64: String) throws -> ARWorldMap {
    guard let data = Data(base64Encoded: base64) else { throw CocoaError(.coderReadCorrupt) }
    let archived = try (data as NSData).decompressed(using: .zlib) as Data
    guard let map = try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: archived) else {
      throw CocoaError(.coderReadCorrupt)
    }
    return map
  }
}

/// Another pinned object of the member, followed while the screen runs.
struct PinnedObject: Record {
  @Field var objectId: String = ""
  @Field var label: String = ""
}

/// An object the vision check confirmed: the center of its box in the sent picture's pixels.
struct FoundObject: Record {
  @Field var objectId: String = ""
  @Field var x: Double = 0
  @Field var y: Double = 0
}

/// The web app's answer to an `ar.check` message.
struct CheckAnswer: Record {
  @Field var checkId: String = ""
  @Field var found: [FoundObject] = []
}

public final class TellyArModule: Module {
  // Main queue only. `live` is the open screen's session; `ended` are closed ones, so a `watch`
  // that arrives late still hears that its screen closed.
  private var live: String?
  private var ended: Set<String> = []
  private var events: [[String: Any]] = []
  private var waiter: (session: String, promise: Promise)?
  private weak var screen: TellyArViewController?

  public func definition() -> ModuleDefinition {
    Name("TellyAr")

    AsyncFunction("capabilities") { (promise: Promise) in
      let reply: [String: Any]
      if !ARWorldTrackingConfiguration.isSupported {
        reply = ["supported": false, "reason": "no-arkit"]
      } else {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
          reply = ["supported": false, "reason": "no-camera-permission"]
        default:
          reply = ["supported": true]
        }
      }
      promise.resolve(reply)
    }

    // `worldMap` is the member's room map to add the pin to; without it, or when it does not
    // decode, the pin starts a new room map. Decoding runs off the main queue.
    AsyncFunction("savePin") {
      (objectId: String, label: String, session: String?, others: [PinnedObject], worldMap: String?, promise: Promise) in
      let base = worldMap.flatMap { try? WorldMapCodec.decode($0) }
      DispatchQueue.main.async {
        self.open(.save(objectId: objectId, label: label, base: base), others: others, session: session, promise: promise)
      }
    }

    AsyncFunction("findPin") {
      (objectId: String, label: String, anchorId: String, worldMap: String, session: String?, others: [PinnedObject], promise: Promise) in
      let map: ARWorldMap
      do {
        map = try WorldMapCodec.decode(worldMap)
      } catch {
        promise.resolve(arError("failed", "The saved room scan could not be read."))
        return
      }
      // The pin is the anchor with the saved id or the pin's name; the screen follows it by name.
      let pinName = Tracking.anchorName(objectId)
      guard map.anchors.contains(where: { $0.identifier.uuidString == anchorId || $0.name == pinName }) else {
        promise.resolve(arError("failed", "The saved room scan has no pin."))
        return
      }
      DispatchQueue.main.async {
        self.open(.find(objectId: objectId, label: label, map: map), others: others, session: session, promise: promise)
      }
    }

    // The next message of the screen with `session`, or `ar.closed` once it closed. `answer` is the
    // web app's answer to the previous `ar.check`.
    AsyncFunction("watch") { (session: String, answer: CheckAnswer?, promise: Promise) in
      if let answer, self.live == session {
        self.screen?.checked(answer.checkId, found: answer.found.map { ($0.objectId, Float($0.x), Float($0.y)) })
      }
      if self.live == session, !self.events.isEmpty {
        promise.resolve(self.events.removeFirst())
      } else if self.ended.contains(session) {
        promise.resolve(["type": "ar.closed"])
      } else {
        // A watch can arrive before its screen opens; the older one is no longer read.
        self.waiter?.promise.resolve(["type": "ar.closed"])
        self.waiter = (session, promise)
      }
    }
    .runOnQueue(.main)
  }

  // Main queue only.
  private func open(_ mode: TellyArViewController.Mode, others: [PinnedObject], session: String?, promise: Promise) {
    if let session { begin(session) }
    let fail = { (answer: [String: Any]) in
      promise.resolve(answer)
      if let session { self.end(session) }
    }
    guard ARWorldTrackingConfiguration.isSupported else {
      fail(arError("failed", "This phone does not support AR."))
      return
    }
    withCamera(fail) {
      guard let parent = self.appContext?.utilities?.currentViewController() else {
        fail(arError("failed", "The app has no screen to show AR on."))
        return
      }
      guard !(parent is TellyArViewController) else {
        fail(arError("failed", "An AR screen is already open."))
        return
      }
      // Without a session the web app does not read messages, so the screen sends none.
      let emit: (([String: Any]) -> Void)? = session.map { id in { [weak self] in self?.push(id, $0) } }
      let screen = TellyArViewController(
        mode: mode,
        others: others.map { ($0.objectId, $0.label) },
        emit: emit
      ) { promise.resolve($0) }
      screen.onClose = { [weak self] in if let session { self?.end(session) } }
      screen.modalPresentationStyle = .fullScreen
      self.screen = screen
      parent.present(screen, animated: true)
    }
  }

  private func begin(_ session: String) {
    if let waiter, waiter.session != session {
      waiter.promise.resolve(["type": "ar.closed"])
      self.waiter = nil
    }
    live = session
    events = []
  }

  private func end(_ session: String) {
    ended.insert(session)
    if live == session {
      live = nil
      events = []
    }
    if let waiter, waiter.session == session {
      waiter.promise.resolve(["type": "ar.closed"])
      self.waiter = nil
    }
  }

  private func push(_ session: String, _ event: [String: Any]) {
    guard live == session else { return }
    if let waiter, waiter.session == session {
      self.waiter = nil
      waiter.promise.resolve(event)
      return
    }
    // Only the newest unread frame is worth checking: a camera frame is large.
    if event["type"] as? String == "ar.check" {
      events.removeAll { $0["type"] as? String == "ar.check" }
    }
    events.append(event)
  }

  // Asks for the camera the first time; a refusal answers `camera-denied`.
  private func withCamera(_ fail: @escaping ([String: Any]) -> Void, _ start: @escaping () -> Void) {
    let denied = arError("camera-denied", "Camera access is off for this app.")
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      start()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          if granted { start() } else { fail(denied) }
        }
      }
    default:
      fail(denied)
    }
  }
}
