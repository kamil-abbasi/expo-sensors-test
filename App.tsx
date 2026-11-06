import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { useKeepAwake } from 'expo-keep-awake';
import { DeviceMotion } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { HeadingFusion, motionHeading } from './src/heading';
import {
  cardinal,
  DeadReckoner,
  GyroHeading,
  PdrSnapshot,
  StepDetector,
  upInDevice,
  verticalAccel,
  yawRate,
} from './src/pdr';

const MAX_PX_PER_METER = 8; // zoom when the user is near the start point
const MARKER_SIZE = 64;
const CALIBRATION_DISTANCE_M = 10;

/** Pick a "nice" ring radius (1, 2, 5, 10, 20, 50 ... m) for the scale circle. */
function niceRadius(meters: number) {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(meters, 1))));
  for (const m of [1, 2, 5, 10]) if (m * pow >= meters) return m * pow;
  return 10 * pow;
}

export default function App() {
  useKeepAwake(); // sensors stop when the screen locks

  const fusion = useRef(new HeadingFusion()).current;
  const gyro = useRef(new GyroHeading()).current;
  const steps = useRef(new StepDetector()).current;
  const reckoner = useRef(new DeadReckoner()).current;

  const [snap, setSnap] = useState<PdrSnapshot>(reckoner.snapshot());
  const [heading, setHeading] = useState<number | null>(null);
  const [walking, setWalking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [calibrated, setCalibrated] = useState(false);

  // Unwrapped heading so the arrow never spins the long way round 359° -> 0°.
  const rotation = useRef(0);
  const applyHeading = (deg: number) => {
    let delta = deg - (((rotation.current % 360) + 360) % 360);
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    if (Math.abs(delta) < 0.5) return; // avoid needless re-renders
    rotation.current += delta;
    setHeading(rotation.current);
  };

  useEffect(() => {
    let headSub: Location.LocationSubscription | undefined;
    let motionSub: { remove(): void } | undefined;
    let cancelled = false;

    (async () => {
      if (!(await DeviceMotion.isAvailableAsync())) {
        setError('Device motion sensors are not available on this device.');
        return;
      }
      await DeviceMotion.requestPermissionsAsync().catch(() => undefined);
      DeviceMotion.setUpdateInterval(20); // 50 Hz for reliable step detection
      motionSub = DeviceMotion.addListener((m) => {
        if (!m.rotation) return;
        const now = Date.now();
        const up = upInDevice(m.rotation.beta, m.rotation.gamma);
        const rr = m.rotationRate;

        // Heading: tilt-compensated absolute heading, stabilised by the gyro.
        const turnRate = rr ? Math.hypot(rr.alpha, rr.beta, rr.gamma) : 0;
        const absolute = fusion.onMotion(motionHeading(m.rotation), turnRate);
        const yr = rr ? yawRate(rr, up, Platform.OS) : 0;
        const h = gyro.update(yr, absolute, now);
        if (h !== null) applyHeading(h);

        // Steps from vertical acceleration (works in any phone orientation).
        let av: number;
        if (m.acceleration) {
          av = verticalAccel(m.acceleration, up, Platform.OS);
        } else {
          const g = m.accelerationIncludingGravity;
          av = Math.hypot(g.x, g.y, g.z) - DeviceMotion.Gravity;
        }
        const len = steps.push(av, now);
        if (len > 0 && h !== null) {
          reckoner.step(len, h);
          setSnap(reckoner.snapshot());
        }
        const isWalking = steps.isWalking(now);
        setWalking((prev) => (prev === isWalking ? prev : isWalking));
      });
      if (cancelled) return;

      // Compass: anchors the heading to north. Location permission lets it use
      // true north (magnetic declination); it still works without it.
      await Location.requestForegroundPermissionsAsync().catch(() => undefined);
      if (cancelled) return;
      headSub = await Location.watchHeadingAsync((hd) => {
        fusion.onCompass(hd.magHeading, hd.trueHeading, hd.accuracy);
      });
      if (cancelled) headSub.remove();
    })().catch((e) => setError(String(e?.message ?? e)));

    return () => {
      cancelled = true;
      headSub?.remove();
      motionSub?.remove();
    };
  }, [fusion, gyro, steps, reckoner]);

  const onReset = () => {
    reckoner.reset();
    setSnap(reckoner.snapshot());
  };

  /** Walk exactly CALIBRATION_DISTANCE_M from a reset, then tap: scales the step length. */
  const onCalibrate = () => {
    const s = reckoner.snapshot();
    if (s.steps < 5) {
      setError(`Reset, walk exactly ${CALIBRATION_DISTANCE_M} m, then tap calibrate.`);
      return;
    }
    steps.k *= CALIBRATION_DISTANCE_M / s.distance;
    setError(null);
    setCalibrated(true);
    onReset();
  };

  const onLayout = (e: LayoutChangeEvent) =>
    setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  // Auto zoom-out so the marker always stays on screen.
  const usable = Math.max(Math.min(area.w, area.h) / 2 - MARKER_SIZE / 2 - 8, 1);
  const pxPerMeter = Math.min(MAX_PX_PER_METER, usable / Math.max(snap.maxExtent, 1));
  const ring = niceRadius(usable / pxPerMeter / 2);
  const cx = area.w / 2;
  const cy = area.h / 2;
  const mx = cx + snap.east * pxPerMeter;
  const my = cy - snap.north * pxPerMeter; // north is up
  const fromStart = Math.hypot(snap.east, snap.north);
  const headingDeg = heading === null ? null : ((Math.round(heading) % 360) + 360) % 360;

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />

      <View style={styles.stats}>
        <Text style={styles.big}>{snap.distance.toFixed(1)} m</Text>
        <Text style={styles.label}>distance traveled</Text>
        <Text style={styles.line}>
          Heading: {headingDeg === null ? '—' : `${headingDeg}° ${cardinal(headingDeg)}`}
        </Text>
        <Text style={styles.line}>
          From start: {fromStart.toFixed(1)} m · {snap.steps} steps
        </Text>
        <Text style={styles.small}>
          {error ??
            (heading === null
              ? 'Starting sensors…'
              : `Dead reckoning · ${walking ? 'walking' : 'standing'}${calibrated ? ' · calibrated' : ''}`)}
        </Text>
      </View>

      <View style={styles.map} onLayout={onLayout}>
        {area.w > 0 && (
          <>
            <View
              style={[
                styles.ring,
                {
                  left: cx - ring * pxPerMeter,
                  top: cy - ring * pxPerMeter,
                  width: ring * pxPerMeter * 2,
                  height: ring * pxPerMeter * 2,
                  borderRadius: ring * pxPerMeter,
                },
              ]}
            />
            <Text style={[styles.ringLabel, { left: cx + 4, top: cy - ring * pxPerMeter + 2 }]}>
              {ring} m
            </Text>
            <View style={[styles.origin, { left: cx - 3, top: cy - 3 }]} />
            <Text style={[styles.north, { left: cx - 5 }]}>N</Text>

            <View
              style={[
                styles.marker,
                {
                  left: mx - MARKER_SIZE / 2,
                  top: my - MARKER_SIZE / 2,
                  transform: [{ rotate: `${heading ?? 0}deg` }],
                },
              ]}
            >
              <View style={styles.arrow} />
              <View style={styles.dot} />
            </View>
          </>
        )}
      </View>

      <Pressable style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]} onPress={onReset}>
        <Text style={styles.buttonText}>Reset position</Text>
      </Pressable>
      <Pressable onPress={onCalibrate} hitSlop={8}>
        <Text style={styles.link}>Calibrate: I walked {CALIBRATION_DISTANCE_M} m since reset</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 60, paddingBottom: 32 },
  stats: { alignItems: 'center', paddingHorizontal: 16 },
  big: { fontSize: 40, fontWeight: '700', color: '#111', fontVariant: ['tabular-nums'] },
  label: { fontSize: 13, color: '#888', marginBottom: 8 },
  line: { fontSize: 17, color: '#222', fontVariant: ['tabular-nums'] },
  small: { fontSize: 13, color: '#888', marginTop: 4 },
  map: { flex: 1, margin: 16, overflow: 'hidden' },
  ring: { position: 'absolute', borderWidth: 1, borderColor: '#e3e3e3' },
  ringLabel: { position: 'absolute', fontSize: 11, color: '#bbb' },
  origin: { position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: '#ccc' },
  north: { position: 'absolute', top: 0, fontSize: 12, color: '#bbb', fontWeight: '600' },
  marker: {
    position: 'absolute',
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Triangle pointing up; the whole marker rotates with the compass heading.
  arrow: {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 11,
    borderRightWidth: 11,
    borderBottomWidth: 20,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#1a73e8',
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#1a73e8',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  button: {
    alignSelf: 'center',
    backgroundColor: '#111',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { alignSelf: 'center', marginTop: 14, fontSize: 13, color: '#1a73e8' },
});
