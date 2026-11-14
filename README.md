# Toolpath Studio

A local browser interface for milling PCBs with `pcb2gcode`. It accepts front and back copper Gerbers, a board outline, and plated or non-plated Excellon drill files. It generates controller-ready G-code and can load each generated file into an integrated 3D stock-removal simulator.

The workflow is for subtractive PCB milling: front/back copper, through-holes, and board profiling. It does not treat internal copper planes as milling layers. KiCad `.gbrjob` files are optional and supply board-name, size, and thickness metadata only.

## Run

Requirements: Python 3.10+, an executable `pcb2gcode` binary, and the included simulator export in `vendor/gcode-simulator/out/`.

```sh
python3 server.py
```

Open <http://127.0.0.1:8080>. The default binary is `../pcb2gcode/build/pcb2gcode`, relative to this project. Override it or the port with:

```sh
PCB2GCODE_BIN=/path/to/pcb2gcode PCB2GCODE_PORT=8080 python3 server.py
```

The service binds to loopback by default. Uploads and generated G-code are held in a temporary directory and deleted after the request. The browser downloads generated files directly; the app does not store board data or settings. It serializes generation jobs, limits each upload to 100 MB, limits generated output to 20 MB, and times out a job after three minutes.

## Production deployment

Run under a dedicated OS account, keep the app bound to loopback, and place TLS and access control at a reverse proxy if remote access is needed. Do not expose this unauthenticated local utility directly on a public interface. The server rejects cross-origin generation requests and passes browser settings through a validated CLI allowlist; input is never interpreted as a shell command.

## Simulator

The 3D preview integrates [G-Code Simulator](https://github.com/federicovezzoli/gcode-simulator), an existing MIT-licensed CNC heightmap simulator. Its source is vendored at `vendor/gcode-simulator/`; upstream provenance and the local integration notes are in [`vendor/gcode-simulator/UPSTREAM.md`](vendor/gcode-simulator/UPSTREAM.md). The simulator accepts G0/G1/G2/G3 toolpaths, separates tool changes, and models material removal at configurable resolution. The app forwards generated G-code and stock dimensions to it in the browser.

The checked-in static export is served at `/simulator/`. To rebuild it after changing simulator source:

```sh
cd vendor/gcode-simulator
npm ci
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
```

The root server needs no Node process at runtime. The simulator dependencies are only needed when rebuilding its static bundle.

## Controls and feature reference

Main controls cover isolation milling and drilling, including drill depth/feed/speed, multiple available drill diameters, one-bit mode, and optional mill-drilling. Tool diameters are parsed from the generated G-code and flow directly into the simulator; simulator tool definitions are read-only. Advanced controls cover multiple mills and offsets; Voronoi and Gerber polarity; contour cutter, depth, infeed, feeds and bridges; independent drill/cut sides and board-flip alignment; probing/autolevelling; path planning, tolerances, tiling and machine motion; and optional custom G-code/preambles. Metric and imperial display units are supported.

[`features.txt`](./features.txt) is included and linked in the interface as the complete `pcb2gcode 3.1.0 --help` reference. It documents all engine options, including options that are intentionally not exposed as form controls.
# pcb2gcode-app
# pcb2gcode-app
