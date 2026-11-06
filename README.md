# Sensors Test

Minimal Expo app that tracks distance traveled and heading indoors with dead reckoning, using `expo-sensors` (DeviceMotion) and `expo-location` (compass).

- White screen with a marker that starts in the center; the arrow points to the compass heading (north is up).
- The marker moves step by step, in meters relative to the start point (auto zooms out to stay on screen; the ring shows scale).
- **Reset position** puts the marker back in the center and zeroes the distance.

## Distance: pedestrian dead reckoning (`src/pdr.ts`)

Built for indoor use, where GPS doesn't work. For every detected step the marker moves `stepLength` meters in the current heading.

- **Steps**: vertical linear acceleration (DeviceMotion, projected on the gravity axis so phone orientation doesn't matter), low-passed at ~3 Hz; a step is an upward bounce > 1 m/s² that falls back through zero, 280 ms–2 s apart.
- **Step length**: Weinberg model `K · (aMax − aMin)^¼`, so longer strides at faster pace. Default `K = 0.45`.
- **Calibration**: tap *Reset position*, walk exactly 10 m, tap *Calibrate*. This scales `K` to your stride (kept until the app restarts).
- **Heading**: gyro-integrated yaw (rotation about the vertical axis) anchored to the absolute heading below with a 20 s complementary filter, so short magnetic disturbances indoors (steel, appliances) are smoothed out.

## Heading (`src/heading.ts`)

A plain compass gives the direction of the phone's top edge, which breaks when the phone is held upright. The arrow instead uses DeviceMotion's fused orientation and projects the device vector `top - screenNormal` onto the horizontal plane: that is the top edge when flat, the back-camera direction when upright, and "in front of you" at any tilt in between. Whenever the phone is held fairly flat (< 40° tilt) and not turning fast, the offset to the regular compass (`Location.watchHeadingAsync`) is learned, and magnetic declination is applied so the arrow shows true north.

## Run

This app needs a development build (it uses native sensor modules):

```bash
npm install
npx eas-cli@latest build --profile development --platform android   # or ios
npx expo start --dev-client
```
