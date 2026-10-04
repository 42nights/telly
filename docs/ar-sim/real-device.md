# Real-iPhone checks for each simulation scenario

The simulation does not run ARKit. Each scenario below has one matching check on a real iPhone, so that a person can confirm the simulated result in a real room. Do these checks with the iOS app build from the AR pin PR. The [procedures](procedures.md) give the matching simulation commands and pass criteria.

## Before you start

- Use an iPhone that supports ARKit world tracking (iPhone XS or later). Write down the model and whether it has LiDAR (Pro models from iPhone 12 Pro).
- Use your own home or a room that you are allowed to scan. A world map is a scan of the home: do not send it, log it, or copy it from the device for the check.
- Measure with a ruler or a tape measure. Take a screenshot at each "record" step.
- Use real medicine boxes or empty boxes of the same size (about 8 x 12 x 15 cm). Do not take medicine for the check.
- Record the results in the table at the end of each section. A check that you did not do is "not done", never "passed".

## 1. Single object: save, close, reopen, find

Simulation: `run.py`, case `baseline`.

1. Put one box on a cabinet or a shelf. Turn on the room light.
2. In the medicine finder, tap "Pin it in AR". Move the phone slowly around the box for 5 to 10 seconds, then tap the box.
3. Close the app fully (swipe it away). Open it again.
4. Stand 1 to 2.5 m from the box, facing away from it. Tap "Show me in AR".
5. Do what the app shows: turn slowly, then follow the arrow.
6. When the marker shows, take a screenshot. Measure the distance from the marker centre to the point you tapped on the box. Use the box size on the screen as the scale.
7. Do steps 3 to 6 ten times, from different start points.

Pass: the marker shows in at least 9 of 10 tries, every marker is on the box, and the distance is at most 5 cm in at least 9 of 10 tries.

| try | start distance m | marker shown | seconds to marker | marker distance cm |
|---|---|---|---|---|

## 2. Pairing mode, arrow, then marker

Simulation: every `run.py` trial (stages P, A, M) and `multi.py` (pairing, "hold still", arrows).

1. Do the find flow of check 1, but start facing a wall that has no furniture.
2. Record the text that the app shows while it pairs ("Turn slowly and look around the room").
3. After one full turn without a match, record whether the app asks you to walk closer.
4. When the arrow shows, record whether it points toward the box (within about 15 degrees).
5. Record whether the marker shows only after the arrow, and never at a wrong place.

Pass: pairing completes in at least 19 of 20 tries, the arrow points toward the box, and no marker shows at a wrong place.

## 3. Failure sweep

Simulation: `run.py` cases `short-scan`, `featureless-walls`, `big-lighting-change`, `far-start`. These cases have no pass bar; they show where the app must give guidance.

| Case | Real check | Expected result |
|---|---|---|
| short-scan | Tap the box after less than one second of scanning. | The app does not save, and shows "Move your phone slowly around the box". |
| featureless-walls | Pin a box in front of a plain painted wall with no furniture near it. | Pairing is slow or does not complete. The app shows "Point your phone at furniture or objects near the medicine". |
| big-lighting-change | Pin in normal light. Find with only a small lamp on. | Pairing is slow or does not complete. The app shows "Turn on a light". No marker at a wrong place. |
| far-start | Start the find 3 to 4 m from the box. | Pairing takes longer. The app shows "Walk closer to where you pinned the medicine". |

Pass for every case: no marker shows at a wrong place. When the app cannot find the box, it keeps the guidance on and shows no marker.

## 4. Many objects in one room

Simulation: `multi.py`, N = 1, 3, 5, 10, 20.

1. Put 10 boxes in one room: 4 on a cabinet, 3 on a table, 3 on a sofa or a second shelf. Put some boxes 10 to 30 cm apart. Use at least 3 identical boxes (same brand). Put one tall box (a cereal box) in front of one medicine box.
2. Pin each box: walk up to it, about 60 to 90 cm away, step a little to the side, and tap it. If something hides it, step around or hold the phone higher.
3. Close the app fully and open it again.
4. Start the find from the room door. Do what the app shows: turn slowly, hold still when it asks, then follow the nearest arrow.
5. Record the seconds to the first marker and to the last marker.
6. For each marker, check that its label belongs to the box under it. Measure the distance from each marker to the point you tapped.
7. While some boxes are off the screen, take a screenshot. Check that each of them has an arrow and that the nearest box is first.
8. Do steps 3 to 7 three times. Then do the same with 20 boxes.

Pass: no marker is on the wrong box and no two labels are swapped, in every try. At least 95 of 100 marker distances are at most 5 cm. Every off-screen box has an arrow, nearest first.

| try | boxes | seconds to first marker | seconds to all markers | wrong or swapped markers | markers over 5 cm |
|---|---|---|---|---|---|

Also record the map size that the app reports (`mapBytes`, a number only). The storage contract keeps one world map per container, so a room with 20 pins stores 20 copies of the map unless the server shares one map per room.

## 5. Usual place

Simulation: `usual.py`.

1. Two family members each use the finder for at least 14 days. Each member has their own containers, and both have one container with the same name (for example, Vitamin D) that they keep in different places.
2. Each day, each member writes on paper where they found each container.
3. On days 7, 14, and 30, record the "usually kept" line that the app shows for each container of each member.
4. Compare each line with the paper record: the place that the line names first must be the place written most often in the last 10 records of that member.

Pass: for containers that stay in one place at least 70 percent of the time, the line names that place by day 14 in at least 9 of 10 containers. Each member's line uses only that member's sightings: the two Vitamin D lines name each member's own place. When the line says "usually", the place that it names is right in at least 95 percent of the checks.
