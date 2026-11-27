# Changelog

## 0.3.1

- The touch screen stays while driving (platform app/touch_mode 1.1.0):
  Touch screen stays on while moving; a stream still stops when the car
  moves. Needs Moonlight 0.3.1.

## 0.3.0

- The touch screen first: opening the app opens Moonlight's touch screen by
  itself (while parked): the phone page's QR code, the stream with Stop,
  Quit game and Resume last, Picture on, on / off, and an Info tab. Its List
  button (top right), BACK or the car starting to move bring this list
  back; the list's new first row, Touch screen, opens it again (platform
  app/touch_mode). A stream on the centre console hides it until it ends.
- The page's texts are plain ASCII (they had dashes and a dot the HMI may
  not have); "only while parked" says the speed in mph.
- Needs vizualyse-moonlight 0.3.0.

## 0.2.1

- No change to the page: its shared files (the QR code, the car's speed) now
  come from the platform's modules, byte for byte as before.

## 0.2.0

- Picture on: a drop-down for where the picture goes (centre console,
  cluster, HUD); a stream moves there.
- Only while parked: the app reads the car's speed (Vehicle2) every second
  and sends it to the tool, which stops a stream above 3 km/h. The app keeps
  the tool's socket while it runs, not only while its page shows.
- The info line says whether the GPU decodes.
- Requires vizualyse-moonlight 0.2.0.

## 0.1.0

- The page: status and info (host, game, fps, controllers), the phone link
  as a QR code and as text, Moonlight on / off, Stop (the game keeps running
  on the PC), Quit game (closes it on the PC) and Resume last (the last host
  and game again).
- Requires vizualyse-moonlight 0.1.0.
