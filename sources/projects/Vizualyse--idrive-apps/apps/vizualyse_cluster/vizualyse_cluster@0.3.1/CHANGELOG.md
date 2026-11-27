# Changelog

## 0.3.1

- The picker stays while driving (platform app/touch_mode 1.1.0): Touch
  screen stays on while moving; Try is still parked only. Needs Cluster
  themes 0.4.1.

## 0.3.0

- The touch screen first: opening the app opens the theme picker on the
  screen by itself (while parked). Its List button (top right), BACK or
  the car starting to move bring this list back; the list's first row,
  Touch screen, opens it again (platform app/touch_mode). Needs Cluster
  themes 0.4.0.

## 0.2.1

- The fuel gauge: litres as a share of the 330e's 40 l tank.
- Electric power: the e-motor's drive and regen (relative, taken as %, of
  its 109 hp; unconfirmed), and the powertrain's power read raw to learn
  its scaling.
- 12 V: the head unit's supply voltage (LevelMonitor `systemVoltage`,
  instance `Inst1`; a little under the battery's), its unit from its size.
- The manifest asks for those three fields too (21 in all, checked against
  our unit's catalog).

## 0.2.0

- **The car's readings on the cluster**: the app reads the car over SOME/IP
  and sends the theme its speed, rpm, gear (and S/M program), drive mode
  (which picks Sport or Comfort), oil and coolant temperature, outside
  temperature, engine power (from torque and rpm), boost, throttle, g
  forces, fuel (litres), range, odometer, electric range, battery charge,
  trip distance, average speed and consumption, and the tyres' pressures
  and temperatures, converted from the car's units. Values the car marks
  invalid show as `--`. Boost, throttle, battery charge, electric range and
  the trip computer's figures use scalings not yet checked against a car:
  the app logs their raw values once for checking.
- The manifest asks for those fields; every one is in our unit's SOME/IP
  catalog with the access asked for (`tools/check_signals.js`).

## 0.1.0

- The first page of the Cluster themes tool (vizualyse-cluster 0.2.0): a row
  per theme family (pressing one puts it on the cluster and turns themes on),
  Sport or Comfort (by the drive mode, always Sport, always Comfort), the
  car's strip under the theme shown or covered, themes on or off.
- **Choose with previews**: the tool's picker on the central screen, read
  by touch: a large preview of each theme in Sport and Comfort, Use, a 10 s
  Try on the cluster while parked. The page opens an empty screen state
  under it first, and hides the picker on BACK, HOME, another app or a
  pop-up. Only while parked.
- The car's speed goes to the tool once a second.
