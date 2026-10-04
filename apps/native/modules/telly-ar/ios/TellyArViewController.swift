// The full-screen AR screen for saving and finding an object pin.
// Ideas from Apple's "Saving and Loading World Data" sample (Apple Sample Code License): save only
// when `worldMappingStatus` is `.mapped` or `.extending`, and ask the person to move the phone
// while the session relocalizes. No code is copied. The find follows the stages that the ar-sim
// tool (tools/ar-sim) measured: pairing mode, then an arrow, then the marker once the pin is stable.
// While the camera runs, every saved object of the member in the room is followed at once (#351):
// a marker with its name once it holds still, and an edge arrow with the distance while it is off
// screen. A vision check of the camera frame that sees an object more than 0.5 m from its anchor
// moves the anchor, and the web app saves the new sighting and room map.
import ARKit
import CoreImage
import SceneKit
import UIKit

final class TellyArViewController: UIViewController, ARSCNViewDelegate, ARSessionDelegate {
  enum Mode {
    /// `base` is the member's room map: the new pin joins the pins already in it.
    case save(objectId: String, label: String, base: ARWorldMap?)
    case find(objectId: String, label: String, map: ARWorldMap)
  }

  // Pairing mode stays on until the person cancels; this only settles the request before the web
  // app's own 10-minute limit.
  private static let relocalizationTimeout: TimeInterval = 9 * 60
  // A save that finds no match for the member's room map in this time is in another room.
  private static let baseMapTimeout: TimeInterval = 20
  // A vision check that gets no answer in this time is dropped.
  private static let checkTimeout: TimeInterval = 30
  private static let imageContext = CIContext()

  private struct PendingCheck {
    let id: String
    let objectIds: [String]
    let camera: simd_float4x4
    let intrinsics: simd_float3x3
    let image: simd_float2
    let sentAt: TimeInterval
    var sent: simd_float2?
  }

  private let mode: Mode
  private var reply: (([String: Any]) -> Void)?
  private let emit: (([String: Any]) -> Void)?
  /// Called once the screen is gone.
  var onClose: (() -> Void)?
  /// Anchor name to label of every pin this screen knows. Immutable: the render queue reads it.
  private let labels: [String: String]
  private var tracker: Tracker
  private let sceneView = ARSCNView()
  private let hint = UILabel()
  private let hintBox = UIView()
  private let closeButton = UIButton(type: .system)
  private let pinButton = UIButton(type: .system)
  private let crosshair = UIView()
  private var arrows: [String: ArrowView] = [:]
  private var saving = false
  private var timeout: Timer?
  // The session had its first normal fix: on the saved room map, when it runs with one.
  private var relocalized = false
  private var lost = false
  private var pending: PendingCheck?
  // Find mode: pairing progress before the first fix.
  private var pairingTurn: Float = 0
  private var lastYaw: Float?

  init(
    mode: Mode,
    others: [(objectId: String, label: String)],
    emit: (([String: Any]) -> Void)?,
    reply: @escaping ([String: Any]) -> Void
  ) {
    self.mode = mode
    self.emit = emit
    self.reply = reply
    var followed = others
    var labels: [String: String] = [:]
    switch mode {
    case .save(let objectId, let label, _):
      followed.removeAll { $0.objectId == objectId }
      labels[Tracking.anchorName(objectId)] = label
    case .find(let objectId, let label, _):
      followed.removeAll { $0.objectId == objectId }
      followed.insert((objectId, label), at: 0)
    }
    for object in followed { labels[Tracking.anchorName(object.objectId)] = object.label }
    self.labels = labels
    tracker = Tracker(followed)
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  // A screen that goes away without an answer still settles the promise.
  deinit {
    reply?(arError("cancelled", "The AR screen closed."))
  }

  private var label: String {
    switch mode {
    case .save(_, let label, _), .find(_, let label, _): return label
    }
  }

  /// The object being saved or searched.
  private var objectId: String {
    switch mode {
    case .save(let objectId, _, _), .find(let objectId, _, _): return objectId
    }
  }

  private var isSave: Bool {
    if case .save = mode { return true }
    return false
  }

  // MARK: - Layout

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    sceneView.delegate = self
    sceneView.session.delegate = self
    sceneView.automaticallyUpdatesLighting = true
    sceneView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(sceneView)

    hint.numberOfLines = 0
    hint.textAlignment = .center
    hint.textColor = .white
    hint.font = UIFont.preferredFont(forTextStyle: .headline)
    hint.adjustsFontForContentSizeCategory = true
    hint.accessibilityTraits = .updatesFrequently
    hint.translatesAutoresizingMaskIntoConstraints = false
    hintBox.backgroundColor = UIColor.black.withAlphaComponent(0.7)
    hintBox.layer.cornerRadius = 12
    hintBox.translatesAutoresizingMaskIntoConstraints = false
    hintBox.addSubview(hint)
    view.addSubview(hintBox)

    var close = UIButton.Configuration.filled()
    close.baseBackgroundColor = UIColor.black.withAlphaComponent(0.7)
    close.baseForegroundColor = .white
    close.title = "Cancel"
    closeButton.configuration = close
    closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    closeButton.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(closeButton)

    let guide = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      sceneView.topAnchor.constraint(equalTo: view.topAnchor),
      sceneView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      sceneView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      sceneView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      closeButton.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
      closeButton.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      hintBox.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 12),
      hintBox.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      hintBox.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
      hint.topAnchor.constraint(equalTo: hintBox.topAnchor, constant: 12),
      hint.bottomAnchor.constraint(equalTo: hintBox.bottomAnchor, constant: -12),
      hint.leadingAnchor.constraint(equalTo: hintBox.leadingAnchor, constant: 16),
      hint.trailingAnchor.constraint(equalTo: hintBox.trailingAnchor, constant: -16),
    ])

    if isSave {
      // The dot marks the spot the pin goes to.
      crosshair.backgroundColor = UIColor.white.withAlphaComponent(0.3)
      crosshair.layer.borderColor = UIColor.white.cgColor
      crosshair.layer.borderWidth = 3
      crosshair.layer.cornerRadius = 14
      crosshair.isUserInteractionEnabled = false
      crosshair.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(crosshair)

      var pin = UIButton.Configuration.filled()
      pin.baseBackgroundColor = .systemBlue
      pin.title = "Pin here"
      pin.buttonSize = .large
      pinButton.configuration = pin
      pinButton.isEnabled = false
      pinButton.accessibilityHint = "Saves where the \(label) is."
      pinButton.addTarget(self, action: #selector(pinHere), for: .touchUpInside)
      pinButton.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(pinButton)

      NSLayoutConstraint.activate([
        crosshair.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        crosshair.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        crosshair.widthAnchor.constraint(equalToConstant: 28),
        crosshair.heightAnchor.constraint(equalToConstant: 28),
        pinButton.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
        pinButton.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
        pinButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
      ])
      setHint("Move your phone slowly around the room so it can learn the space.")
    } else {
      setHint("Turn slowly and look around the room.")
    }
  }

  private func configuration(_ map: ARWorldMap?) -> ARWorldTrackingConfiguration {
    let configuration = ARWorldTrackingConfiguration()
    configuration.planeDetection = [.horizontal, .vertical]
    configuration.initialWorldMap = map
    return configuration
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    let map: ARWorldMap?
    switch mode {
    case .save(_, _, let base):
      map = base
      if base != nil {
        setHint("Looking for your room. Move your phone slowly around it.")
        timeout = Timer.scheduledTimer(withTimeInterval: Self.baseMapTimeout, repeats: false) { [weak self] _ in
          self?.startNewRoom()
        }
      }
    case .find(_, _, let saved):
      map = saved
      timeout = Timer.scheduledTimer(withTimeInterval: Self.relocalizationTimeout, repeats: false) { [weak self] _ in
        self?.finish(arError("relocalization-failed", "The room did not match the saved scan."))
      }
    }
    sceneView.session.run(configuration(map), options: [.resetTracking, .removeExistingAnchors])
    UIApplication.shared.isIdleTimerDisabled = true
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    timeout?.invalidate()
    sceneView.session.pause()
    UIApplication.shared.isIdleTimerDisabled = false
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    onClose?()
    onClose = nil
  }

  private func setHint(_ text: String) {
    guard hint.text != text else { return }
    hint.text = text
    UIAccessibility.post(notification: .announcement, argument: text)
  }

  // MARK: - Answers

  private func send(_ answer: [String: Any]) {
    guard let reply else { return }
    self.reply = nil
    reply(answer)
  }

  private func finish(_ answer: [String: Any]) {
    send(answer)
    if presentingViewController != nil { dismiss(animated: true) }
  }

  @objc private func closeTapped() {
    finish(arError("cancelled", "The person closed the AR screen."))
  }

  // MARK: - Save

  // The member's room map did not match: this is another room, so the pin starts a new map.
  private func startNewRoom() {
    guard isSave, !relocalized, !saving else { return }
    setHint("Move your phone slowly around the room so it can learn the space.")
    sceneView.session.run(configuration(nil), options: [.resetTracking, .removeExistingAnchors])
  }

  @objc private func pinHere() {
    guard isSave, !saving else { return }
    let center = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
    guard let query = sceneView.raycastQuery(from: center, allowing: .estimatedPlane, alignment: .any),
          let hit = sceneView.session.raycast(query).first
    else {
      setHint("Point the dot at a surface where the \(label) is, then tap Pin here.")
      return
    }
    saving = true
    pinButton.isEnabled = false
    setHint("Saving the pin…")
    let anchor = place(objectId, at: hit.worldTransform)
    saveMap(adding: [anchor]) { [weak self] data, pins in
      self?.finish([
        "type": "ar.pinSaved",
        "anchorId": anchor.identifier.uuidString,
        "worldMap": data.base64EncodedString(),
        "mapBytes": data.count,
        "anchors": pins,
      ])
    } failed: { [weak self] notReady in
      self?.finish(arError(
        notReady ? "mapping-not-ready" : "failed",
        notReady ? "The room scan needs more detail." : "The room scan could not be saved."
      ))
    }
  }

  /// Replaces the object's anchor with a new one at `transform`.
  private func place(_ objectId: String, at transform: simd_float4x4) -> ARAnchor {
    let name = Tracking.anchorName(objectId)
    for old in sceneView.session.currentFrame?.anchors ?? [] where old.name == name {
      sceneView.session.remove(anchor: old)
    }
    let anchor = ARAnchor(name: name, transform: transform)
    sceneView.session.add(anchor: anchor)
    return anchor
  }

  /// The room map with `added` in place of older anchors of the same objects, and without pins of
  /// objects this screen does not know (a thing the member forgot). Encoded off the main queue.
  private func saveMap(
    adding added: [ARAnchor],
    then done: @escaping (_ data: Data, _ pins: [[String: String]]) -> Void,
    failed: @escaping (_ notReady: Bool) -> Void
  ) {
    let labels = self.labels
    sceneView.session.getCurrentWorldMap { map, error in
      guard let map else {
        let notReady = (error as? ARError)?.code == .insufficientFeatures
        DispatchQueue.main.async { failed(notReady) }
        return
      }
      let ids = Set(added.map(\.identifier))
      let names = Set(added.compactMap(\.name))
      map.anchors.removeAll { anchor in
        guard let name = anchor.name, Tracking.objectId(anchorName: name) != nil else { return false }
        return labels[name] == nil || (names.contains(name) && !ids.contains(anchor.identifier))
      }
      // A new anchor can miss the map when the session has not processed it yet.
      for anchor in added where !map.anchors.contains(where: { $0.identifier == anchor.identifier }) {
        map.anchors.append(anchor)
      }
      let pins = map.anchors.compactMap { anchor -> [String: String]? in
        guard let id = Tracking.objectId(anchorName: anchor.name) else { return nil }
        return ["objectId": id, "anchorId": anchor.identifier.uuidString]
      }
      DispatchQueue.global(qos: .userInitiated).async {
        let data = try? WorldMapCodec.encode(map)
        DispatchQueue.main.async {
          if let data { done(data, pins) } else { failed(false) }
        }
      }
    }
  }

  // MARK: - ARSessionDelegate (main queue)

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    let tracking = frame.camera.trackingState
    if !relocalized {
      guard case .normal = tracking else {
        pinButton.isEnabled = false
        if case .find = mode { pair(frame) }
        return
      }
      relocalized = true
      if isSave { timeout?.invalidate() }
    }
    switch tracking {
    case .notAvailable, .limited(.relocalizing):
      lose(frame)
      return
    default:
      lost = false
    }
    let target = follow(frame)
    if isSave {
      guard !saving else { return }
      let ready = frame.worldMappingStatus == .mapped || frame.worldMappingStatus == .extending
      pinButton.isEnabled = ready
      setHint(ready
        ? "Point the dot at the \(label), then tap Pin here."
        : "Move your phone slowly around the room so it can learn the space.")
    } else {
      switch target {
      case nil: setHint("Turn slowly and look around the room.")
      case .marker?: setHint("Your \(label) is at the red dot.")
      case .steady?: setHint("Walk toward the arrow and hold your phone steady.")
      case .turn?: setHint("Turn toward the arrow to see your \(label).")
      }
    }
    startCheck(frame)
  }

  // Pairing mode: no fix yet. One full turn without a fix asks the person to walk closer.
  private func pair(_ frame: ARFrame) {
    let yaw = frame.camera.eulerAngles.y
    if let lastYaw {
      let step = remainderf(yaw - lastYaw, 2 * .pi)
      pairingTurn += abs(step)
    }
    lastYaw = yaw
    if (frame.lightEstimate?.ambientIntensity ?? 1000) < 100 {
      setHint("Turn on a light, then turn slowly and look around the room.")
    } else if pairingTurn >= 2 * .pi {
      setHint("Walk closer to where you pinned the \(label) and look around.")
    } else {
      setHint("Turn slowly and look around the room.")
    }
  }

  // Relocalization was lost: markers and arrows hide until the room is found again. The anchors stay.
  private func lose(_ frame: ARFrame) {
    pinButton.isEnabled = false
    setHint("Hold on, finding the room again.")
    guard !lost else { return }
    lost = true
    tracker.lose()
    for anchor in frame.anchors where labels[anchor.name ?? ""] != nil {
      sceneView.node(for: anchor)?.isHidden = true
    }
    for arrow in arrows.values { arrow.isHidden = true }
  }

  private enum Guide { case marker, steady, turn }

  /// Updates every followed object's marker and arrow; returns the searched object's state.
  private func follow(_ frame: ARFrame) -> Guide? {
    var anchors: [String: ARAnchor] = [:]
    for anchor in frame.anchors {
      if let name = anchor.name, labels[name] != nil { anchors[name] = anchor }
    }
    tracker.update(anchors.mapValues { simd_make_float3($0.transform.columns.3) })
    let view = frame.camera.viewMatrix(for: .portrait)
    let bounds = sceneView.bounds
    let size = simd_float2(Float(bounds.width), Float(bounds.height))
    var target: Guide?
    for id in tracker.objects.keys {
      guard let position = tracker.objects[id]?.position else {
        arrows[id]?.isHidden = true
        continue
      }
      let bearing = Tracking.bearing(view: view, to: position)
      let projected = sceneView.projectPoint(SCNVector3(position.x, position.y, position.z))
      let point = CGPoint(x: CGFloat(projected.x), y: CGFloat(projected.y))
      let onScreen = bearing.ahead && bounds.insetBy(dx: 24, dy: 24).contains(point)
      if onScreen, tracker.settle(id), id == objectId, !isSave {
        timeout?.invalidate()
        var done = closeButton.configuration
        done?.title = "Done"
        closeButton.configuration = done
        send(["type": "ar.pinFound"])
      }
      guard let object = tracker.objects[id] else { continue }
      if let anchor = anchors[Tracking.anchorName(id)] {
        sceneView.node(for: anchor)?.isHidden = !object.settled
      }

      let arrow = arrows[id] ?? makeArrow(id)
      let text = Tracking.arrowText(label: object.label, distance: bearing.distance)
      let state: Guide
      if object.settled, onScreen {
        arrow.isHidden = true
        state = .marker
      } else if onScreen {
        // Not stable yet: the arrow sits under the pin and points up at it.
        arrow.show(
          at: CGPoint(x: point.x, y: min(point.y + 72, bounds.maxY - 56)),
          angle: 0,
          text: text
        )
        state = .steady
      } else {
        let edge = Tracking.edgePoint(size: size, inset: ArrowView.inset, angle: bearing.angle)
        arrow.show(at: CGPoint(x: CGFloat(edge.x), y: CGFloat(edge.y)), angle: CGFloat(bearing.angle), text: text)
        state = .turn
      }
      if id == objectId { target = state }
    }
    return target
  }

  private func makeArrow(_ id: String) -> ArrowView {
    let arrow = ArrowView()
    view.insertSubview(arrow, belowSubview: hintBox)
    arrows[id] = arrow
    return arrow
  }

  // MARK: - Passive update

  // Sends a camera frame to the web app's vision check when an object is due one: at most one
  // check per object every 10 s, and one at a time. The frame is the phone's own camera image; it
  // goes only to the web app, which asks the family's server.
  private func startCheck(_ frame: ARFrame) {
    guard let emit, !saving, case .normal = frame.camera.trackingState else { return }
    let now = frame.timestamp
    if let pending, now - pending.sentAt < Self.checkTimeout { return }
    pending = nil
    let due = tracker.due(at: now)
    guard !due.isEmpty else { return }
    tracker.checked(due, at: now)
    let id = UUID().uuidString
    let buffer = frame.capturedImage
    pending = PendingCheck(
      id: id,
      objectIds: due,
      camera: frame.camera.transform,
      intrinsics: frame.camera.intrinsics,
      image: simd_float2(Float(CVPixelBufferGetWidth(buffer)), Float(CVPixelBufferGetHeight(buffer))),
      sentAt: now
    )
    let capturedAt = ISO8601DateFormatter.string(
      from: Date(),
      timeZone: TimeZone(identifier: "UTC")!,
      formatOptions: [.withInternetDateTime, .withFractionalSeconds]
    )
    DispatchQueue.global(qos: .utility).async {
      let picture = Self.uprightJpeg(buffer)
      DispatchQueue.main.async { [weak self] in
        guard let self, self.pending?.id == id else { return }
        guard let picture else {
          self.pending = nil
          return
        }
        self.pending?.sent = simd_float2(Float(picture.width), Float(picture.height))
        emit([
          "type": "ar.check",
          "checkId": id,
          "objectIds": due,
          "image": picture.data.base64EncodedString(),
          "width": picture.width,
          "height": picture.height,
          "capturedAt": capturedAt,
        ])
      }
    }
  }

  // The camera image turned upright for a portrait screen, at most 1280 px on its longer side.
  private static func uprightJpeg(_ buffer: CVPixelBuffer) -> (data: Data, width: Int, height: Int)? {
    let upright = CIImage(cvPixelBuffer: buffer).oriented(.right)
    let scale = min(1, 1280 / max(upright.extent.width, upright.extent.height))
    let image = upright.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let width = Int(image.extent.width.rounded()), height = Int(image.extent.height.rounded())
    guard let data = imageContext.jpegRepresentation(
      of: image,
      colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
      options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7]
    ) else { return nil }
    return (data, width, height)
  }

  /// The web app's answer to a check: where in the sent picture it confirmed each object.
  func checked(_ checkId: String, found: [(objectId: String, x: Float, y: Float)]) {
    guard let check = pending, check.id == checkId, let sent = check.sent else { return }
    pending = nil
    guard !lost, !saving else { return }
    var moved: [ARAnchor] = []
    for item in found where check.objectIds.contains(item.objectId) {
      guard let anchor = tracker.objects[item.objectId]?.position else { continue }
      let pixel = Tracking.imagePixel(upright: simd_float2(item.x, item.y), sent: sent, image: check.image)
      let ray = Tracking.ray(pixel: pixel, intrinsics: check.intrinsics, camera: check.camera)
      let query = ARRaycastQuery(origin: ray.origin, direction: ray.direction, allowing: .estimatedPlane, alignment: .any)
      guard let hit = sceneView.session.raycast(query).first,
            Tracking.moved(from: anchor, to: simd_make_float3(hit.worldTransform.columns.3))
      else { continue }
      moved.append(place(item.objectId, at: hit.worldTransform))
    }
    guard !moved.isEmpty, let emit else { return }
    let objectIds = moved.compactMap { Tracking.objectId(anchorName: $0.name) }
    // The sighting is saved even when the map is not: the next find then starts at the old spot.
    saveMap(adding: moved) { data, pins in
      emit([
        "type": "ar.moved",
        "checkId": checkId,
        "objectIds": objectIds,
        "worldMap": data.base64EncodedString(),
        "anchors": pins,
      ])
    } failed: { _ in
      emit(["type": "ar.moved", "checkId": checkId, "objectIds": objectIds])
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    let denied = (error as? ARError)?.code == .cameraUnauthorized
    finish(arError(denied ? "camera-denied" : "failed", denied ? "Camera access is off for this app." : "AR stopped working."))
  }

  // MARK: - ARSCNViewDelegate (render queue)

  // Every known pin gets a marker; it shows once it holds still. The pin being saved shows at once.
  func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
    guard let name = anchor.name, let label = labels[name] else { return nil }
    let marker = Self.makeMarker(label: label)
    if case .save(let objectId, _, _) = mode, name == Tracking.anchorName(objectId) { return marker }
    marker.isHidden = true
    return marker
  }

  // A pulsing red dot with the object's name above it, always facing the camera.
  private static func makeMarker(label: String) -> SCNNode {
    let root = SCNNode()

    let sphere = SCNSphere(radius: 0.025)
    sphere.firstMaterial?.diffuse.contents = UIColor.systemRed
    sphere.firstMaterial?.lightingModel = .constant
    let dot = SCNNode(geometry: sphere)
    dot.runAction(.repeatForever(.sequence([
      .scale(to: 1.4, duration: 0.6),
      .scale(to: 1.0, duration: 0.6),
    ])))
    root.addChildNode(dot)

    let text = SCNText(string: label, extrusionDepth: 0)
    text.font = UIFont.systemFont(ofSize: 12, weight: .bold)
    text.flatness = 0.1
    text.firstMaterial?.diffuse.contents = UIColor.white
    text.firstMaterial?.lightingModel = .constant
    let (low, high) = text.boundingBox
    let scale: Float = 0.004
    let width = (high.x - low.x) * scale
    let height = (high.y - low.y) * scale
    let words = SCNNode(geometry: text)
    words.scale = SCNVector3(scale, scale, scale)
    words.position = SCNVector3(-width / 2 - low.x * scale, -height / 2 - low.y * scale, 0.001)

    let plate = SCNPlane(width: CGFloat(width + 0.02), height: CGFloat(height + 0.012))
    plate.cornerRadius = CGFloat(height + 0.012) / 4
    plate.firstMaterial?.diffuse.contents = UIColor.black.withAlphaComponent(0.75)
    plate.firstMaterial?.lightingModel = .constant
    let tag = SCNNode(geometry: plate)
    tag.addChildNode(words)
    tag.position = SCNVector3(0, 0.06 + height / 2, 0)
    tag.constraints = [SCNBillboardConstraint()]
    root.addChildNode(tag)

    return root
  }
}

/// An object's arrow: a red arrow that turns toward the object, and "keys · 2.1 m" under it.
// ponytail: arrows of objects in the same direction overlap; spread them if rooms hold many pins.
private final class ArrowView: UIView {
  /// Keeps the arrow and its text on the screen.
  static let inset: Float = 76
  private let arrow = UIImageView(image: UIImage(systemName: "arrow.up.circle.fill"))
  private let text = UILabel()

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 140, height: 88))
    isUserInteractionEnabled = false
    isAccessibilityElement = true
    arrow.tintColor = .systemRed
    arrow.backgroundColor = .white
    arrow.layer.cornerRadius = 28
    arrow.frame = CGRect(x: 42, y: 0, width: 56, height: 56)
    addSubview(arrow)
    text.frame = CGRect(x: 0, y: 60, width: 140, height: 28)
    text.textAlignment = .center
    text.textColor = .white
    text.font = UIFont.systemFont(ofSize: 15, weight: .bold)
    text.adjustsFontSizeToFitWidth = true
    text.minimumScaleFactor = 0.6
    text.backgroundColor = UIColor.black.withAlphaComponent(0.7)
    text.layer.cornerRadius = 8
    text.layer.masksToBounds = true
    addSubview(text)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  func show(at point: CGPoint, angle: CGFloat, text value: String) {
    isHidden = false
    center = CGPoint(x: point.x, y: point.y + 16)
    arrow.transform = CGAffineTransform(rotationAngle: angle)
    if text.text != value {
      text.text = value
      accessibilityLabel = value
    }
  }
}
