// The guide arrow (#348): where a locked-on object is when the camera no longer shows it. While
// locked, the object's direction in the room is the phone's orientation applied to the box's
// direction in the camera's view. As the phone turns, that direction goes back into the camera's
// view: inside the view it is a place on screen, outside it an arrow. Without motion sensors, the
// arrow points to the edge where the object left the frame.

/** `DeviceOrientationEvent` angles in degrees. */
export type Orientation = {
	readonly alpha: number;
	readonly beta: number;
	readonly gamma: number;
};

/** A direction: device or room axes. */
export type Vec = readonly [number, number, number];
type Frame = { readonly width: number; readonly height: number };

/** Where the object is, against the screen: on it at a frame point, or off it in a direction. */
export type Seen =
	| { readonly kind: "in"; readonly x: number; readonly y: number }
	| {
			readonly kind: "off";
			/** Screen angle in radians: 0 points right, π/2 points down. */
			readonly angle: number;
			readonly behind: boolean;
	  };

/** The camera's field of view across the frame's longer side. */
// ponytail: one value near phone main cameras (26 mm equivalent); calibrate per device if the box
// lands off the object after a turn.
const LONG_SIDE_FOV_DEG = 65;

const rad = Math.PI / 180;

/** tan(half view angle) across the frame's width and height. */
const halfTan = ({ width, height }: Frame) => {
	const long = Math.tan((LONG_SIDE_FOV_DEG * rad) / 2);
	const side = Math.max(width, height);
	return { x: (long * width) / side, y: (long * height) / side };
};

/** Device-to-room rotation rows (W3C DeviceOrientation, Z-X'-Y''). */
const rotation = ({ alpha, beta, gamma }: Orientation): readonly Vec[] => {
	const [cA, sA] = [Math.cos(alpha * rad), Math.sin(alpha * rad)];
	const [cB, sB] = [Math.cos(beta * rad), Math.sin(beta * rad)];
	const [cG, sG] = [Math.cos(gamma * rad), Math.sin(gamma * rad)];
	return [
		[cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG],
		[cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB],
		[-cB * sG, sB, cB * cG],
	];
};

/**
 * The room direction of a frame point. The rear camera looks along the device's −z; frame x runs
 * right and y down; `screenAngle` is `screen.orientation.angle`.
 */
export const roomDirection = (
	orientation: Orientation,
	point: { readonly x: number; readonly y: number },
	frame: Frame,
	screenAngle: number,
): Vec => {
	const tan = halfTan(frame);
	const sx = ((point.x / frame.width) * 2 - 1) * tan.x;
	const sy = (1 - (point.y / frame.height) * 2) * tan.y;
	// Screen axes to device axes: turn back by the screen angle.
	const a = -screenAngle * rad;
	const d: Vec = [
		sx * Math.cos(a) - sy * Math.sin(a),
		sx * Math.sin(a) + sy * Math.cos(a),
		-1,
	];
	return rotation(orientation).map(
		([r0, r1, r2]) => r0 * d[0] + r1 * d[1] + r2 * d[2],
	) as unknown as Vec;
};

/** Where a room direction is against the screen, with the phone held at `orientation`. */
export const seenAt = (
	room: Vec,
	orientation: Orientation,
	frame: Frame,
	screenAngle: number,
): Seen => {
	const r = rotation(orientation);
	// Room to device: the transposed rotation.
	const [dx, dy, dz] = [0, 1, 2].map(
		(i) =>
			(r[0]?.[i] ?? 0) * room[0] +
			(r[1]?.[i] ?? 0) * room[1] +
			(r[2]?.[i] ?? 0) * room[2],
	) as [number, number, number];
	const a = screenAngle * rad;
	const sx = dx * Math.cos(a) - dy * Math.sin(a);
	const sy = dx * Math.sin(a) + dy * Math.cos(a);
	const tan = halfTan(frame);
	if (dz < 0) {
		const u = sx / -dz / tan.x;
		const v = sy / -dz / tan.y;
		if (Math.abs(u) <= 1 && Math.abs(v) <= 1)
			return {
				kind: "in",
				x: ((u + 1) / 2) * frame.width,
				y: ((1 - v) / 2) * frame.height,
			};
	}
	// Straight behind has no side: turn right.
	const angle = sx === 0 && sy === 0 ? 0 : Math.atan2(-sy, sx);
	return { kind: "off", angle, behind: dz >= 0 };
};

/** A box center this close to an edge (share of the frame) left through that edge. */
const EDGE = 0.25;

/**
 * Without motion sensors: the screen angle from the frame's center to where a lost object was
 * last seen, when that was near an edge; null when it was lost in the middle of the frame.
 */
export const edgeHint = (
	center: { readonly x: number; readonly y: number },
	frame: Frame,
): number | null => {
	const u = center.x / frame.width;
	const v = center.y / frame.height;
	if (u > EDGE && u < 1 - EDGE && v > EDGE && v < 1 - EDGE) return null;
	return Math.atan2(v - 0.5, u - 0.5);
};

/** The words for an arrow: "Turn left", "Tilt up", "It is behind you. Turn right". */
export const guideWords = (angle: number, behind: boolean) => {
	const x = Math.cos(angle);
	const y = Math.sin(angle);
	const turn = x < 0 ? "Turn left" : "Turn right";
	if (behind) return `It is behind you. ${turn}`;
	if (Math.abs(x) >= Math.abs(y)) return turn;
	return y < 0 ? "Tilt up" : "Tilt down";
};

/**
 * While locked on: walk toward an object in the middle third of the view, else turn toward it.
 */
// ponytail: no distance; the web camera has no depth. Add meters from AR when the shell sends them.
export const lockedGuide = (
	center: { readonly x: number; readonly y: number },
	frame: Frame,
) => {
	const u = center.x / frame.width;
	if (u < 1 / 3) return { angle: Math.PI, words: "Turn left" };
	if (u > 2 / 3) return { angle: 0, words: "Turn right" };
	return { angle: -Math.PI / 2, words: "Walk forward" };
};
