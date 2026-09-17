# Morphogen — Live UX red-team (computerUse)
**Target:** https://morphogen-synth.grok.me  
**Date:** 2026-09-17 (America/New_York)

## Works
- Splash: “EARTH CAVITY · 7.83 HZ”; living chemical field copy; ENTER; “First gesture unlocks audio and motion.”
- Clicking ENTER unlocked animated field + controls immediately.
- Field rendered continuously; no blank/WebGL error observed in-session.
- Dragging created bright expanding cyan colonies; field stats changed.
- Explicit **Lock loop** worked → status “LOOP 1”, loop indicator highlighted.
- Visual/audio evidence via animated field + changing HUM frequency readouts (e.g. 448 / 249 / 374 Hz). Audible output not independently verified by the tool.

## UX friction
- Chrome MIDI permission: “wants to Control and reprogram your MIDI devices” — blocked during probe.
- Double-tap-hold did **not** visibly lock; explicit Lock loop control did (confirms discoverability gap from static analysis).
- Sound panel notes sleeping tabs may need tap to wake.
- Image/camera not exercised (file/camera permission).

## Bugs / gaps in probe
- No console inspection; resize/fullscreen/reload not completed before wrap-up.
- TD Connect remained default `ws://127.0.0.1:9980` / Idle (aligns with Elliot C1 — no live Sync from HTTPS).
- `/td/morphogen_ws_callbacks.py` download started successfully.

## Panels observed
- **Field:** presets Mitosis, Solitons, Pulsing, Holes, Mazes, Fingerprint, Spirals, Worms, Coral, Skate; palettes; reseed/reset/record.
- **Image:** Add image, camera, Inoculate/Develop/Resist/Palette only, Image mix, Sample colors.
- **Body:** Tilt & motion on; Microphone off.
- **Sound:** Voice of the field, Hum/Schumann, Level 70%, Mute, waveforms Sine/Triangle/Saw/Square/Pulse/Spectrum.
- **Sync:** TD WebSocket JSON @ 20 Hz, optional 16×16 grid, Copy/Download TD callbacks; MIDI-to-TD CCs 20–29.

## Screenshots
- Drag response / colonies: `shot-drag.webp`
- Post-MIDI-block field: `shot-field.webp`
- MIDI permission prompt: `shot-midi-prompt.webp`
