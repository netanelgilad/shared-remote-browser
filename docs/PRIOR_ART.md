# Prior art and design lineage

Shared Remote Browser keeps its own small CDP-specific viewer, but its behavior and architecture deliberately follow mature open-source prior art.

## Chrome DevTools frontend

Chrome DevTools is the canonical implementation of CDP screencasting and input transforms. The viewer follows these patterns:

- preserve `deviceWidth`, `deviceHeight`, `offsetTop`, `pageScaleFactor`, and scroll offsets;
- derive remote pointer coordinates from the actual displayed frame size;
- subtract `offsetTop` from input coordinates;
- release pointer state when focus is lost;
- cap and floor screencast dimensions; and
- surface inactive-target state.

References:

- [ScreencastView.ts](https://github.com/ChromeDevTools/devtools-frontend/blob/e1cbac7cc827a07658ecac071e21ce86fe477782/front_end/panels/screencast/ScreencastView.ts)
- [InputModel.ts](https://github.com/ChromeDevTools/devtools-frontend/blob/e1cbac7cc827a07658ecac071e21ce86fe477782/front_end/panels/screencast/InputModel.ts)
- [ScreenCaptureModel.ts](https://github.com/ChromeDevTools/devtools-frontend/blob/e1cbac7cc827a07658ecac071e21ce86fe477782/front_end/core/sdk/ScreenCaptureModel.ts)
- License: BSD-3-Clause.

## Herdr Browser

Herdr Browser is the closest MIT-licensed architectural reference. Shared Remote Browser independently implements these ideas:

- one target-aware CDP controller rather than a screencast per viewer;
- browser-level target discovery and popup adoption via `openerId`;
- explicit stop, detach, attach, bring-to-front, and restart when switching tabs;
- passive and interactive screencast acknowledgement pacing;
- downstream capacity checks and latest-only delivery for slow observers; and
- stale-frame replacement rather than retaining every full JPEG.

References at reviewed commit `be6888b71cf4eb5939ee79a746bd1a1c22ade046`:

- [Target, tab, screencast, and viewport controller](https://github.com/ogulcancelik/herdr-browser/blob/be6888b71cf4eb5939ee79a746bd1a1c22ade046/src/browser.ts)
- [Screencast acknowledgement pacer](https://github.com/ogulcancelik/herdr-browser/blob/be6888b71cf4eb5939ee79a746bd1a1c22ade046/src/screencastAckPacer.ts)
- [Scoped CDP gateway](https://github.com/ogulcancelik/herdr-browser/blob/be6888b71cf4eb5939ee79a746bd1a1c22ade046/src/cdpGateway.ts)
- License: MIT.

## noVNC

noVNC is the strongest maintained reference for remote-control UX on mobile browsers. Because its JavaScript is MPL-2.0 and its transport is VNC/RFB rather than CDP, this project uses a clean implementation of the behavioral concepts rather than copying source:

- distinguish tap, long press, scroll, pan, and pinch after a movement threshold;
- prevent an incomplete or cancelled gesture from leaking an accidental click;
- coalesce pointer and scroll movement to animation frames;
- map coordinates against the rendered element and clamp them;
- bridge native mobile keyboard input through a hidden textarea with filler text;
- support clipboard fallback, focus cleanup, reconnect states, and wake lock; and
- render only the newest complete frame when decoding falls behind.

References at reviewed noVNC 1.7.0 commit `7c36fabe599e053c5a81e98e091ac636f6c1e174`:

- [Gesture recognizer](https://github.com/novnc/noVNC/blob/7c36fabe599e053c5a81e98e091ac636f6c1e174/core/input/gesturehandler.js)
- [Gesture tests](https://github.com/novnc/noVNC/blob/7c36fabe599e053c5a81e98e091ac636f6c1e174/tests/test.gesturehandler.js)
- [Keyboard handling](https://github.com/novnc/noVNC/blob/7c36fabe599e053c5a81e98e091ac636f6c1e174/core/input/keyboard.js)
- [Display and coordinate handling](https://github.com/novnc/noVNC/blob/7c36fabe599e053c5a81e98e091ac636f6c1e174/core/display.js)
- [Mobile keyboard UI](https://github.com/novnc/noVNC/blob/7c36fabe599e053c5a81e98e091ac636f6c1e174/app/ui.js)
- License: MPL-2.0 for core JavaScript; BSD-2-Clause for HTML/CSS portions.

## Browserless and Selenoid

Browserless informed general reconnect and session-accounting considerations, while Selenoid demonstrates the established browser-container plus noVNC fallback. Neither viewer was used as a code source:

- Browserless core is SSPL-1.0 or commercially licensed, and its debugger is GPL-3.0-or-later or commercial.
- Selenoid’s VNC UI controls a container desktop rather than an arbitrary existing local CDP page.

The project therefore retains a narrow MIT-licensed implementation tailored to a local Mac Chrome session and documents noVNC/full-desktop control as the fallback for native UI.
