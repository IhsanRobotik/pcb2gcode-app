# Vendored simulator provenance

- Upstream: https://github.com/federicovezzoli/gcode-simulator
- Imported revision: `766ef4d1ba64797a0247e48137f985262df59409`
- License: MIT; see [`LICENSE`](LICENSE)

Local integration changes:

- Parent-page `postMessage` loading for generated `pcb2gcode` G-code and stock dimensions.
- Automatic tool diameter detection from `pcb2gcode` tool-change labels and support for 0.05 mm tool settings.
- Parsing of the tool labels emitted by `pcb2gcode`.
- Read-only tool inventory, feed-timed G-code playback, and a moving tool marker driven by parsed coordinates and feed rates.
- Adaptive board-scale heightmap resolution, sub-cell cutter coverage, and labeled visual Z exaggeration for shallow cuts.
- The integration UI's drill depths, feed, spindle speed, available bit diameters, single-bit mode, and mill-drilling controls are configured in the main job form, not in the simulator.
- Next.js dependency updated to 16.4.6, and external GoatCounter telemetry removed.

The source remains the upstream simulator; the PCB app only normalizes the G-code tool-change handoff and XY origin before sending it to the simulator.
