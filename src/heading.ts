import { Platform } from 'react-native';

/**
 * Tilt-independent heading ("which way is the user facing") built from
 * DeviceMotion's fused orientation (gyro + accelerometer + magnetometer).
 *
 * A plain compass reports the direction of the phone's TOP EDGE. That works
 * when the phone lies flat, but when you hold it normally (tilted towards your
 * face, or upright) the top edge points at the sky and the compass becomes
 * unstable or wrong.
 *
 * Instead we take the device vector  f = Y - Z  (top edge minus screen normal)
 * and project it onto the horizontal plane:
 *   - phone flat:     Z is vertical, so f -> top edge direction
 *   - phone upright:  Y is vertical, so f -> back-camera direction
 *   - anything in between: both components point forward and add up
 * so the result is the direction in front of the user at any tilt.
 *
 * DeviceMotion's yaw can have a constant offset from true north (platform
 * reference frame, magnetic declination). While the phone is held fairly flat,
 * where the regular compass is reliable, we continuously learn that offset
 * from `Location.watchHeadingAsync` and apply it at every tilt.
 */

type Vec3 = [number, number, number];

/** R = Rz(a) * Rx(b) * Ry(g) applied to v (device -> world). */
function rotate(a: number, b: number, g: number, v: Vec3): Vec3 {
  const [x0, y0, z0] = v;
  // Ry(g)
  const cg = Math.cos(g), sg = Math.sin(g);
  const x1 = cg * x0 + sg * z0;
  const y1 = y0;
  const z1 = -sg * x0 + cg * z0;
  // Rx(b)
  const cb = Math.cos(b), sb = Math.sin(b);
  const x2 = x1;
  const y2 = cb * y1 - sb * z1;
  const z2 = sb * y1 + cb * z1;
  // Rz(a)
  const ca = Math.cos(a), sa = Math.sin(a);
  return [ca * x2 - sa * y2, sa * x2 + ca * y2, z2];
}

const wrap360 = (d: number) => ((d % 360) + 360) % 360;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const DEG = 180 / Math.PI;

export type MotionHeading = {
  /** Facing direction, degrees clockwise from the sensor's north reference. */
  heading: number;
  /** 0° = phone flat (screen up), 90° = phone upright. */
  tilt: number;
};

/**
 * @param rotation DeviceMotion `rotation` (radians).
 * Android: W3C convention, world frame X=east, Y=north, Z=up.
 * iOS: CoreMotion yaw/pitch/roll in the xMagneticNorthZVertical frame,
 *      X=north, Y=west, Z=up.
 */
export function motionHeading(
  rotation: { alpha: number; beta: number; gamma: number },
  os: string = Platform.OS,
): MotionHeading | null {
  const { alpha, beta, gamma } = rotation;
  const top = rotate(alpha, beta, gamma, [0, 1, 0]);
  const normal = rotate(alpha, beta, gamma, [0, 0, 1]);
  const f: Vec3 = [top[0] - normal[0], top[1] - normal[1], top[2] - normal[2]];

  let east: number, north: number;
  if (os === 'ios') {
    north = f[0];
    east = -f[1];
  } else {
    east = f[0];
    north = f[1];
  }
  if (Math.hypot(east, north) < 0.2) return null; // degenerate pose
  const tilt = Math.acos(Math.max(-1, Math.min(1, normal[2]))) * DEG;
  return { heading: wrap360(Math.atan2(east, north) * DEG), tilt };
}

/** Max tilt at which the plain compass is trusted for calibration. */
const CALIBRATION_MAX_TILT = 40;
/** Ignore calibration samples while the phone is turning quickly. */
const CALIBRATION_MAX_ROTATION_RATE = 30; // deg/s
const CALIBRATION_SMOOTHING = 0.05;

export class HeadingFusion {
  private offX = 1; // learned offset as a unit vector (cos, sin)
  private offY = 0;
  private calibrated = false;
  private declination = 0;
  private last: MotionHeading | null = null;
  private lastRate = 0;

  /** Feed every DeviceMotion sample. Returns the corrected true heading. */
  onMotion(m: MotionHeading | null, rotationRateDegS: number): number | null {
    this.lastRate = rotationRateDegS;
    if (!m) return null;
    this.last = m;
    return this.output(m);
  }

  /** Feed every `watchHeadingAsync` sample. */
  onCompass(magHeading: number, trueHeading: number, accuracy: number) {
    if (trueHeading >= 0) this.declination = wrap180(trueHeading - magHeading);
    const m = this.last;
    if (!m || m.tilt > CALIBRATION_MAX_TILT) return;
    if (this.lastRate > CALIBRATION_MAX_ROTATION_RATE) return;
    if (accuracy < 1 && this.calibrated) return; // uncalibrated compass
    const diff = (wrap180(magHeading - m.heading) * Math.PI) / 180;
    if (!this.calibrated) {
      this.offX = Math.cos(diff);
      this.offY = Math.sin(diff);
      this.calibrated = true;
    } else {
      this.offX += CALIBRATION_SMOOTHING * (Math.cos(diff) - this.offX);
      this.offY += CALIBRATION_SMOOTHING * (Math.sin(diff) - this.offY);
    }
  }

  isCalibrated() {
    return this.calibrated;
  }

  private output(m: MotionHeading) {
    const offset = Math.atan2(this.offY, this.offX) * DEG;
    return wrap360(m.heading + offset + this.declination);
  }
}
