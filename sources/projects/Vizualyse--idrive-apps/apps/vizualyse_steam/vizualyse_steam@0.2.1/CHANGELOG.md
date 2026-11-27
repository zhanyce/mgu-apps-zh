# Changelog

## 0.2.1

- The touch screen stays while driving (platform app/touch_mode 1.1.0):
  Touch screen stays on while moving; the game's picture is still parked
  only (Show and Play off while moving). Needs Steam 0.3.1.

## 0.2.0

- **Opens on the touch screen** (the Steam tool's, 0.3.0) while parked: the
  running game with Show on the screen and Stop the game, the library four
  games a page, the download, and Settings (the picture's shape and size,
  Upscaling, Steam on / off, the phone page's QR code). Its **List** button
  (top right), BACK or the car starting to move bring this page back; the
  new first row, **Touch screen**, opens it again.
- Show (here or on the touch screen) puts the game in the touch screen's
  place over the same screen state; when the game stops or is hidden, the
  touch screen comes back while that state is open.

## 0.1.3

- **Upscaling** button under Picture: off (Winston enlarges the picture),
  FSR (AMD's FSR 1 on the car's GPU, sharper), FSR without sharpening;
  applies to a running game at once. Needs the Steam tool 0.1.11; an older
  one shows "Upscaling: not in this Steam tool (update it)".

## 0.1.2

- No change to the page: its shared files (the QR code, the car's speed) now
  come from the platform's modules, byte for byte as before.

## 0.1.1

- A game on a USB stick that isn't plugged in says so on its Play button
  (`Play: <game> (USB stick not plugged in)`) and can't be pressed (tool
  0.1.1 installs games on USB sticks).

## 0.1.0

- The page: status, the phone link as a QR code and as text (sign in to
  Steam and install games there), a Play button for each installed game (up
  to four), Show on the screen, Stop the game, Picture (the size the game
  draws at), Steam on / off, what is playing and what is downloading.
- Play from the car shows the game once it draws (through an empty screen
  page, so touches on the game press nothing of the HMI).
- Leaving the page (the back arrow, another app) or an HMI pop-up over it
  hides the game; it keeps running until Stop.
- Only while parked: the car's speed (Vehicle2) goes to the tool every
  second.
- Requires vizualyse-steam 0.1.0.
