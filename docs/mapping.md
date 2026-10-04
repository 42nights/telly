# 3D home mapping evaluation

Evaluation of the whiteboard idea "2D photos to a 3D home map (Gaussian splatting)" for room-level guidance ([#48](https://github.com/ayaangazali/telly/issues/48), parent [#25](https://github.com/ayaangazali/telly/issues/25)).
Plan: [`docs/plan.md`](plan.md) (Product: "A 3D home map is not required.") and the board card "3D home map · not required" in [`board.html#integration-reasons`](board.html#integration-reasons).

## Recommendation: no-go for now

Do not build a 3D home map now. Keep the map out of every contract, route, table, and client.

- Two map-free features answer "Where are my tablets?". The current-frame marker ([#15](https://github.com/ayaangazali/telly/issues/15)) has its server route on `main` (PR #72). The last-seen place ([#29](https://github.com/ayaangazali/telly/issues/29)) is in open [PR #105](https://github.com/ayaangazali/telly/pull/105).
- A map adds a large private capture of the home and a GPU reconstruction step. It adds no proof that the system knows where the person is.
- Room navigation and world-locked arrows need measured localization and a display that can project into the world. No current target device has proof of either one (see [Navigation needs](#navigation-needs-localization-and-projection)).
- This is not a statement that navigation is safe or unsafe. No navigation is built or promised.

Reopen the decision only when every [go condition](#go-conditions) has evidence.

## Evidence limit

- **No consented capture was done.** This lane had no consented test room and no capture device. No private home was scanned. No real image was captured, stored, or published.
- The reconstruction figures below come from the published 3D Gaussian Splatting paper and its reference code. They are not measured on a Telly room.
- The comparison of the last-seen place and the current-frame marker uses their merged and proposed contracts and their published synthetic proofs. It does not use a live Gemini call.
- The drift figures are geometry from assumed errors. They are not measured on a device.
- The [consented capture protocol](#consented-capture-protocol) below is the open HITL step. A person with a consented room and a device must do it.

## Capture needs

What a Gaussian-splatting map needs, from the paper ([Kerbl et al. 2023](https://arxiv.org/abs/2308.04079)) and its [reference code](https://github.com/graphdeco-inria/gaussian-splatting):

- **Many overlapping photos of a static scene.** The input is "a set of images of a static scene" with cameras calibrated by Structure-from-Motion (COLMAP). Each surface must be in several photos from different positions.
- **A still room.** People, pets, and moved objects break the static-scene assumption. The capture must happen when no other person is in the room.
- **A CUDA GPU with 24 GB of memory** to train at the paper's quality. A phone cannot train the map. A cloud GPU is a paid resource and needs a separate approval.
- **Calibration that works.** COLMAP can fail on blank walls, mirrors, glass, and dark rooms. A failed calibration gives no map.

## Reconstruction limits

- **Training time:** about 5 to 7 minutes (7K iterations) and 27 to 42 minutes (30K iterations) for each scene on an A6000 GPU (paper Table 1).
- **Map size:** 270 to 734 MB for each scene (paper Table 1, 7K and 30K iterations). These are dataset averages. A home with several rooms needs more captures or a larger one.
- **Static only:** the map shows the room at capture time. A medicine box that moves after the capture stays in its old place in the map. The map cannot tell the person where the box is now.
- **Artifacts:** the paper reports "floaters" near the input cameras and artifacts "in regions where the scene is not well observed". Shelves, drawers, and the inside of cupboards are regions like this.
- **No identity:** the map has colors and shapes, not labels. To find a medicine box in the map, Gemini must still detect it in an image. That is the #15 step.

## Drift

A world-locked arrow lands wrong by about the same distance as the pose error.

- A 5 cm pose error moves the arrow about 5 cm. That is about the width of a small medicine box. At 1.5 m, 5 cm is about 1.9° of view angle.
- Inside-out tracking drifts over time and loses its pose in dark, blank, or changed rooms. We have no measurement of drift on a Telly device.
- A last-seen place and a current-frame marker have no pose, so they have no drift. The #15 marker is drawn on the same frame that Gemini checked.

## Latency

| Step | Map approach | Current approach |
|---|---|---|
| First use | Capture the room, then 6 to 42 min of GPU training before any help | None |
| After an object moves | Capture and train again, or show a wrong place | #29 marks the old place "out of date", and a new #15 sighting replaces it |
| Each request | Find the pose, then project an arrow | One Gemini call for each frame. Clients drop answers for stale frames (`capturedAt`) |

We have no live Gemini latency yet. That needs an approved `GEMINI_API_KEY` (#15, decision `telly-provider-access`).

## Storage

| Data | Size | Content |
|---|---|---|
| #29 `medicine_sighting` row | Some hundreds of bytes | Container, room or landmark, `seenAt`, source, confidence |
| #15 detection reply | Some hundreds of bytes | Frame id, `capturedAt`, boxes in frame pixels. The image is not stored |
| One-room Gaussian-splatting map | 270 to 734 MB (paper) | A photo-quality 3D copy of the room |

A map is about a million times larger than a sighting. It is also a detailed copy of the home. Treat it as a health-adjacent personal record, not as a cache.

## Deletion

- #29 deletes all sightings when the family turns remembering off. The proof is in [PR #105](https://github.com/ayaangazali/telly/pull/105).
- A map has more copies: the source photos, the COLMAP files, the trained map, and any cloud GPU workspace. Each copy needs a deletion step and a check.
- Backups need the same rule. Retention is the open decision `telly-retention-policy`. Do not store a map before that decision.

## Bystander privacy

- A capture records everything in the room: other people, photos on the wall, documents, screens, and other medicines.
- Visitors and other residents cannot easily consent to a 3D copy of a shared room. A map trained with a person in it can keep that person in the map.
- A current frame is sent once for detection and is not stored. A last-seen row stores only a room name. These two approaches keep much less bystander data.
- Any future capture needs written consent from every resident of the room, an empty room during capture, and an agreed deletion date.

## Comparison

| Need | #29 last-seen landmark | #15 current-frame marker | 3D map |
|---|---|---|---|
| Says which room to go to | Yes, with "last seen … ago" | No | Only the room at capture time |
| Finds the box when the person is there | No | Yes, on the frame it was found in | No. It still needs #15 |
| Handles a moved box | Yes: "out of date", then a new sighting | Yes, on each new frame | No. It needs a new capture |
| Needs a pose or a calibrated display | No | No | Yes, for any arrow in the room |
| Data kept | One row for each container | None | Hundreds of MB of home imagery |
| Works on phone and web without glasses | Yes | Yes | Viewing only. No guidance |

The map adds one thing: a 3D view of the room. It does not improve "which room" or "where in this frame". #29 and #15 cover those two needs.

## Navigation needs: localization and projection

A rendered model is not navigation. A world-locked arrow needs two separate proofs:

1. **Measured localization:** the pose of the device in the map, with a measured error (for example a few cm), in the consented room, in normal light.
2. **Device projection:** a display that can draw at a 3D place in the wearer's view, with a measured alignment error.

What the current devices give:

- **Meta Ray-Ban Display through DAT:** a [600 × 600 display](https://wearables.developer.meta.com/docs/develop/dat/display-overview) driven by 2D components (FlexBox, Text, Image, Button, Icon, Video) over Bluetooth. Each send replaces the full view. The documentation shows no 3D anchor or world-locked projection API. DAT 1.0 lists camera, microphone, audio, motion, and IMU ([FAQ](https://developers.meta.com/wearables/faq)). An IMU measures rotation and acceleration. It does not give a measured position in a map.
- **Ray-Ban Display Web Apps:** the [FAQ](https://developers.meta.com/wearables/faq) lists "device position" as a context signal. The pages reviewed do not state a measured 6-DoF position in a room or world-locked drawing. A device test must measure it before any claim.
- **Phone and web:** the phone camera can show the #15 marker on the frame. Phone AR frameworks (ARKit, ARCore) can track a pose, but no Telly code uses them. A phone pose would also need its own drift measurement.
- **#19 alignment:** [#19](https://github.com/ayaangazali/telly/issues/19) (optional, owner @ayaangazali) must prove marker alignment on the real glasses before anyone calls a marker "aligned". Until then, the board's glasses wireframe says "Layout only · not world-locked AR".

## Links and gating

- [#15](https://github.com/ayaangazali/telly/issues/15): current-frame medicine marker. The map does not replace it and does not gate it.
- [#19](https://github.com/ayaangazali/telly/issues/19): optional glasses layout and alignment proof. Any world-locked arrow needs #19 evidence first.
- [#29](https://github.com/ayaangazali/telly/issues/29): last-seen place. This is the room-level answer.
- No core feature and no phone or web startup waits for a map. This evaluation adds no code, so nothing can gate on it.

## Go conditions

Reopen the map only when all of these have evidence:

1. A consented capture (protocol below) shows a need that #29 and #15 do not cover. Record that need as a failed task with #29 and #15.
2. Measured localization error in the consented room is smaller than the target object, over a set time.
3. A target display has a documented API that draws at a 3D position, and #19 shows a measured alignment on that device.
4. A GPU for training is approved (paid resource), and the decision `telly-retention-policy` covers maps and their source photos.
5. A deletion check removes every copy: photos, COLMAP files, the map, cloud workspace, and backups.

## Unresolved hardware requirements

- A capture device and a consented test room. Neither was available to this evaluation.
- A CUDA GPU with 24 GB of memory, or an approved cloud GPU.
- A device with measured 6-DoF localization in the room.
- A display with world-locked projection and a measured alignment (#19).

## Consented capture protocol

This is the open HITL step. Run it only with written consent from every resident of the room.

1. Use a test room with no people, no pets, no documents, no screens, and no real medicine. Use one empty, labeled synthetic box.
2. Record the consent, the room, the device, and a deletion date on #48. Do not post images.
3. Keep the photos on a private, encrypted drive. Do not commit or upload them.
4. Record these values on #48: number of photos, capture time, COLMAP success, training time and GPU, map size, and visible artifacts near the box.
5. Move the box. Record how #29 ("out of date", then a new sighting) and #15 (a new frame) handle the move, and what the old map shows.
6. Delete every copy on the agreed date and record the deletion on #48.
