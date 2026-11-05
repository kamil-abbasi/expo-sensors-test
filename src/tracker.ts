/**
 * Position tracker that turns noisy GPS fixes into a smooth local track with
 * few-meter precision.
 *
 * - GPS fixes are projected into a local East/North plane (meters).
 * - Each axis runs a constant-velocity Kalman filter, with measurement noise
 *   taken from the fix's reported accuracy.
 * - Device motion (accelerometer) tells us when the phone is still. While
 *   still, velocity is clamped to zero and no distance is accumulated, which
 *   removes the GPS "wander" that would otherwise inflate the distance.
 * - Distance is accumulated in steps of at least MIN_STEP_M along the filtered
 *   track, so sub-meter jitter never adds up.
 */

const EARTH_RADIUS_M = 6371008.8;

/** Fixes worse than this (meters, ~68% radius) are ignored. */
export const MAX_ACCEPTED_ACCURACY_M = 25;
/** Distance is only added once the filtered position moved this far. */
const MIN_STEP_M = 1.5;
/** Step must exceed this many standard deviations of the filtered position. */
const STEP_SIGMAS = 2.5;
/** Process noise: how hard we assume a walking/driving user can accelerate (m/s^2). */
const ACCEL_NOISE = 0.5;
/** If GPS reports at least this speed we trust that we are moving even if the phone feels still (e.g. car mount). */
const GPS_MOVING_SPEED_MS = 1.5;

type Axis = { p: number; v: number; p00: number; p01: number; p10: number; p11: number };

function newAxis(p: number, variance: number): Axis {
  return { p, v: 0, p00: variance, p01: 0, p10: 0, p11: 4 };
}

function predict(a: Axis, dt: number, q: number) {
  // x = F x, F = [[1, dt], [0, 1]]
  a.p += a.v * dt;
  // P = F P F' + Q
  const p00 = a.p00 + dt * (a.p10 + a.p01) + dt * dt * a.p11;
  const p01 = a.p01 + dt * a.p11;
  const p10 = a.p10 + dt * a.p11;
  const p11 = a.p11;
  const dt2 = dt * dt;
  a.p00 = p00 + (q * dt2 * dt2) / 4;
  a.p01 = p01 + (q * dt2 * dt) / 2;
  a.p10 = p10 + (q * dt2 * dt) / 2;
  a.p11 = p11 + q * dt2;
}

function update(a: Axis, z: number, r: number) {
  const s = a.p00 + r;
  const k0 = a.p00 / s;
  const k1 = a.p10 / s;
  const y = z - a.p;
  a.p += k0 * y;
  a.v += k1 * y;
  const p00 = (1 - k0) * a.p00;
  const p01 = (1 - k0) * a.p01;
  const p10 = a.p10 - k1 * a.p00;
  const p11 = a.p11 - k1 * a.p01;
  a.p00 = p00;
  a.p01 = p01;
  a.p10 = p10;
  a.p11 = p11;
}

function freeze(a: Axis) {
  a.v = 0;
  a.p01 = 0;
  a.p10 = 0;
  a.p11 = 0.01;
}

export type Fix = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  timestamp: number;
};

export type TrackerSnapshot = {
  /** Marker offset from the reset point, meters (east, north). */
  east: number;
  north: number;
  /** Path length travelled since reset, meters. */
  distance: number;
  /** Last accepted GPS accuracy, meters. */
  accuracy: number | null;
  /** Max distance from the reset point seen since reset (used for auto-zoom). */
  maxExtent: number;
  hasFix: boolean;
};

export class Tracker {
  private refLat = 0;
  private refLon = 0;
  private cosRefLat = 1;
  private x: Axis | null = null; // east
  private y: Axis | null = null; // north
  private lastTs = 0;
  private originE = 0;
  private originN = 0;
  private anchorE = 0;
  private anchorN = 0;
  private distance = 0;
  private maxExtent = 0;
  private accuracy: number | null = null;

  /** Set from the device-motion stream. */
  stationary = false;

  addFix(fix: Fix): boolean {
    const acc = fix.accuracy ?? MAX_ACCEPTED_ACCURACY_M;
    if (acc > MAX_ACCEPTED_ACCURACY_M) return false;
    this.accuracy = acc;

    if (!this.x || !this.y) {
      this.refLat = fix.latitude;
      this.refLon = fix.longitude;
      this.cosRefLat = Math.cos((fix.latitude * Math.PI) / 180);
      this.x = newAxis(0, acc * acc);
      this.y = newAxis(0, acc * acc);
      this.lastTs = fix.timestamp;
      this.reset();
      return true;
    }

    const toRad = Math.PI / 180;
    const e = (fix.longitude - this.refLon) * toRad * this.cosRefLat * EARTH_RADIUS_M;
    const n = (fix.latitude - this.refLat) * toRad * EARTH_RADIUS_M;
    const dt = Math.min(Math.max((fix.timestamp - this.lastTs) / 1000, 0.05), 5);
    this.lastTs = fix.timestamp;

    const still = this.stationary && (fix.speed ?? 0) < GPS_MOVING_SPEED_MS;
    const r = acc * acc;
    if (still) {
      // Zero-velocity update: hold position, only let GPS slowly refine it.
      freeze(this.x);
      freeze(this.y);
      predict(this.x, dt, 0);
      predict(this.y, dt, 0);
    } else {
      predict(this.x, dt, ACCEL_NOISE);
      predict(this.y, dt, ACCEL_NOISE);
    }
    update(this.x, e, r);
    update(this.y, n, r);

    const fe = this.x.p;
    const fn = this.y.p;
    if (still) {
      // Refinements while standing still are not travel.
      this.anchorE = fe;
      this.anchorN = fn;
    } else {
      // Only count a step once it clearly exceeds the filter's own uncertainty,
      // so zig-zag noise around the true path is not added as distance.
      const sigma = Math.sqrt(this.x.p00 + this.y.p00);
      const step = Math.hypot(fe - this.anchorE, fn - this.anchorN);
      if (step >= Math.max(MIN_STEP_M, STEP_SIGMAS * sigma)) {
        this.distance += step;
        this.anchorE = fe;
        this.anchorN = fn;
      }
    }
    this.maxExtent = Math.max(this.maxExtent, Math.hypot(fe - this.originE, fn - this.originN));
    return true;
  }

  /** Put the marker back to the center: current position becomes the new origin. */
  reset() {
    const e = this.x?.p ?? 0;
    const n = this.y?.p ?? 0;
    this.originE = this.anchorE = e;
    this.originN = this.anchorN = n;
    this.distance = 0;
    this.maxExtent = 0;
  }

  snapshot(): TrackerSnapshot {
    return {
      east: (this.x?.p ?? 0) - this.originE,
      north: (this.y?.p ?? 0) - this.originN,
      distance: this.distance,
      accuracy: this.accuracy,
      maxExtent: this.maxExtent,
      hasFix: this.x !== null,
    };
  }
}

/**
 * Detects whether the phone is being carried/moved using linear acceleration
 * (gravity removed). Walking produces regular peaks well above the threshold.
 */
export class StillnessDetector {
  private lastMotionAt = 0;
  constructor(
    private threshold = 0.35, // m/s^2
    private holdMs = 1500,
  ) {}

  /** @param linearAccel magnitude of acceleration without gravity, m/s^2 */
  push(linearAccel: number, now: number): boolean {
    if (linearAccel > this.threshold) this.lastMotionAt = now;
    return this.isStill(now);
  }

  isStill(now: number) {
    return now - this.lastMotionAt > this.holdMs;
  }
}

export function cardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
