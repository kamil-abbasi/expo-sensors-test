# Sensors Test

Minimal Expo app that tracks distance traveled and heading using `expo-location` and `expo-sensors` (DeviceMotion).

- White screen with a marker that starts in the center; the arrow points to the compass heading (north is up).
- The marker moves in meters relative to the start point (auto zooms out to stay on screen; the ring shows scale).
- **Reset position** puts the marker back in the center and zeroes the distance.

## How precision is achieved (`src/tracker.ts`)

- GPS fixes (`Accuracy.BestForNavigation`, ~1 Hz) are projected to a local east/north plane in meters.
- A constant-velocity Kalman filter per axis smooths fixes, weighted by each fix's reported accuracy. Fixes worse than 25 m are dropped.
- DeviceMotion linear acceleration detects when the phone is still; while still, velocity is clamped to zero and no distance accrues (no GPS drift).
- Distance is added only when the filtered position moves beyond its own uncertainty (min 1.5 m), so jitter doesn't inflate it.

Distance comes from GPS (not dead reckoning); device motion only gates it.

## Heading (`src/heading.ts`)

A plain compass gives the direction of the phone's top edge, which breaks when the phone is held upright. The arrow instead uses DeviceMotion's fused orientation and projects the device vector `top - screenNormal` onto the horizontal plane: that is the top edge when flat, the back-camera direction when upright, and "in front of you" at any tilt in between. Whenever the phone is held fairly flat (< 40° tilt) and not turning fast, the offset to the regular compass (`Location.watchHeadingAsync`) is learned, and magnetic declination is applied so the arrow shows true north.

## Run

This app needs a development build (it uses native sensor modules):

```bash
npm install
npx eas-cli@latest build --profile development --platform android   # or ios
npx expo start --dev-client
```
