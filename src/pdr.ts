/**
 * Pedestrian dead reckoning (PDR) for indoor use, where GPS is unavailable or
 * unreliable.
 *
 *   position += stepLength * (sin(heading), cos(heading))   for every step
 *
 * - Steps are detected from the VERTICAL component of linear acceleration
 *   (projected on the gravity axis), so it works however the phone is held.
 * - Step length uses the Weinberg model: L = K * (aMax - aMin)^(1/4), which
 *   adapts to walking speed (bigger bounce = longer stride). K can be
 *   calibrated by walking a known distance.
 * - Heading comes from `GyroHeading` (gyro-integrated, magnetically anchored),
 *   which is far more stable indoors than a raw compass near steel/electronics.
 */

const DEG = 180 / Math.PI;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export type Vec3 = [number, number, number];

/** Rows of R = Rz(a) Rx(b) Ry(g): the world "up" axis expressed in device coordinates. */
export function upInDevice(b: number, g: number): Vec3 {
  // Third row of Rz(a)Rx(b)Ry(g); yaw (a) does not affect it.
  const sb = Math.sin(b), cb = Math.cos(b);
  const sg = Math.sin(g), cg = Math.cos(g);
  return [-cb * sg, sb, cb * cg];
}

// ---------------------------------------------------------------------------
// Step detection
// ---------------------------------------------------------------------------

const LOWPASS = 0.25; // EMA factor at ~50 Hz -> ~3 Hz cutoff
const PEAK_THRESHOLD = 1.0; // m/s^2, vertical bounce needed to count a step
const MIN_STEP_MS = 280; // max ~3.5 steps/s (running)
const MAX_STEP_MS = 2000; // slower than this is not continuous walking
export const DEFAULT_WEINBERG_K = 0.45;
const MIN_STEP_M = 0.25;
const MAX_STEP_M = 1.2;

export class StepDetector {
  private filtered = 0;
  private aboveThreshold = false;
  private max = -Infinity;
  private min = Infinity;
  private lastStepAt = 0;

  constructor(public k = DEFAULT_WEINBERG_K) {}

  /**
   * @param verticalAccel upward linear acceleration, m/s^2
   * @returns step length in meters when a step is detected, otherwise 0
   */
  push(verticalAccel: number, now: number): number {
    this.filtered += LOWPASS * (verticalAccel - this.filtered);
    const a = this.filtered;
    this.max = Math.max(this.max, a);
    this.min = Math.min(this.min, a);

    if (a > PEAK_THRESHOLD) this.aboveThreshold = true;

    // A step = an upward bounce above the threshold, completed when the signal
    // falls back through zero.
    if (this.aboveThreshold && a < 0) {
      this.aboveThreshold = false;
      const dt = now - this.lastStepAt;
      if (dt < MIN_STEP_MS) return 0; // bounce from the same step
      const amplitude = this.max - this.min;
      this.max = -Infinity;
      this.min = Infinity;
      this.lastStepAt = now;
      const len = this.k * Math.pow(Math.max(amplitude, 0), 0.25);
      return Math.min(MAX_STEP_M, Math.max(MIN_STEP_M, len));
    }

    // Reset the swing window when not walking, so old peaks don't inflate
    // the next step's amplitude.
    if (now - this.lastStepAt > MAX_STEP_MS && !this.aboveThreshold) {
      this.max = a;
      this.min = a;
    }
    return 0;
  }

  isWalking(now: number) {
    return now - this.lastStepAt < MAX_STEP_MS;
  }
}

// ---------------------------------------------------------------------------
// Heading: gyro-integrated, slowly anchored to the absolute (magnetic) heading
// ---------------------------------------------------------------------------

/** Seconds for the gyro heading to converge to the absolute heading. */
const ANCHOR_TIME_CONSTANT_S = 20;
/** Snap instead of blend if the two disagree by more than this right after start. */
const INITIAL_SNAP_DEG = 15;

export class GyroHeading {
  private heading: number | null = null;
  private lastT = 0;
  private settledAt = 0;

  /**
   * @param yawRateDegS rotation rate about the world vertical axis (CCW positive), deg/s
   * @param absolute tilt-compensated absolute heading (deg, CW from north), if available
   */
  update(yawRateDegS: number, absolute: number | null, now: number): number | null {
    if (this.heading === null) {
      if (absolute === null) return null;
      this.heading = absolute;
      this.lastT = now;
      this.settledAt = now;
      return this.heading;
    }
    const dt = Math.min((now - this.lastT) / 1000, 0.2);
    this.lastT = now;
    // Compass heading is clockwise, gyro yaw is counter-clockwise.
    this.heading = wrap360(this.heading - yawRateDegS * dt);

    if (absolute !== null) {
      const err = wrap180(absolute - this.heading);
      if (now - this.settledAt < 3000 && Math.abs(err) > INITIAL_SNAP_DEG) {
        this.heading = absolute; // first seconds: compass still settling
      } else {
        // Complementary filter: gyro for short-term, magnet for long-term.
        // Short magnetic disturbances (steel beams, appliances) are averaged out.
        this.heading = wrap360(this.heading + err * Math.min(dt / ANCHOR_TIME_CONSTANT_S, 1));
      }
    }
    return this.heading;
  }
}

/** Rotation rate about world-up (CCW positive), deg/s, from DeviceMotion fields. */
export function yawRate(
  rotationRate: { alpha: number; beta: number; gamma: number },
  up: Vec3,
  os: string,
): number {
  // expo-sensors maps axes differently per platform:
  //   Android: alpha=x, beta=y, gamma=z   iOS: alpha=z, beta=y, gamma=x
  const w: Vec3 =
    os === 'ios'
      ? [rotationRate.gamma, rotationRate.beta, rotationRate.alpha]
      : [rotationRate.alpha, rotationRate.beta, rotationRate.gamma];
  return w[0] * up[0] + w[1] * up[1] + w[2] * up[2];
}

/** Upward linear acceleration, m/s^2. iOS (CoreMotion) reports acceleration with the opposite sign. */
export function verticalAccel(acc: { x: number; y: number; z: number }, up: Vec3, os: string): number {
  const v = acc.x * up[0] + acc.y * up[1] + acc.z * up[2];
  return os === 'ios' ? -v : v;
}

// ---------------------------------------------------------------------------
// Dead reckoning position
// ---------------------------------------------------------------------------

export type PdrSnapshot = {
  east: number;
  north: number;
  distance: number;
  steps: number;
  maxExtent: number;
};

export class DeadReckoner {
  private east = 0;
  private north = 0;
  private distance = 0;
  private steps = 0;
  private maxExtent = 0;

  step(length: number, headingDeg: number) {
    const h = headingDeg / DEG;
    this.east += length * Math.sin(h);
    this.north += length * Math.cos(h);
    this.distance += length;
    this.steps += 1;
    this.maxExtent = Math.max(this.maxExtent, Math.hypot(this.east, this.north));
  }

  reset() {
    this.east = this.north = this.distance = this.maxExtent = 0;
    this.steps = 0;
  }

  snapshot(): PdrSnapshot {
    return {
      east: this.east,
      north: this.north,
      distance: this.distance,
      steps: this.steps,
      maxExtent: this.maxExtent,
    };
  }
}

export function cardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(wrap360(deg) / 45) % 8];
}
