# PCB2gcode web app

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

The service binds to loopback by default. Uploads and generated G-code are held in a temporary directory and deleted after the request. The browser downloads generated files directly; the app does not store board data or settings. It serializes generation jobs, limits each upload to 10 MB, limits generated output to 20 MB, and times out a job after three minutes.

## Production deployment

Run under a dedicated OS account, keep the app bound to loopback, and place TLS and access control at a reverse proxy if remote access is needed. Do not expose this unauthenticated local utility directly on a public interface. The server rejects cross-origin generation requests and passes browser settings through a validated CLI allowlist; input is never interpreted as a shell command.

## Included examples

Choose an **Included example** in Board files to load its layers, or upload your own files. Click **Generate toolpaths** when ready. After changing machining settings, use **Re-generate toolpaths** to apply them. Generation runs only on demand, with an animated progress indicator; edits made during a job invalidate its result and wait for your next click.

Add new boards under `gerber/`, preferably one subfolder per board. Use KiCad names such as `board-F_Cu.gbr`, `board-B_Cu.gbr`, `board-Edge_Cuts.gbr`, `board-PTH.drl`, `board-NPTH.drl`, and `board-job.gbrjob`. Front/back/outline names and `.gtl`, `.gbl`, `.gko`, and `.gm1` exports are also recognized. Gerber X2 file-function headers and KiCad job metadata supply layer roles when present. Internal copper and non-machining layers are skipped.

Click the refresh icon beside the picker to discover added or removed files; no code changes or server restart are needed. Files for each board should share a name prefix; job metadata can associate Gerbers with arbitrary filenames. Keep board variants in separate subfolders so each example has one file per role. Selecting an example replaces the current board files and clears the old preview while preserving machining settings, with board thickness updated from its job file when supplied.

## Local documentation

The book icon in the top bar opens `/wiki/` in a separate tab. It renders Markdown from `pcb2gcode.wiki/` with full-text search, local page links, code-copy buttons, section navigation, and light/dark themes. New Markdown pages are discovered when the documentation is opened or refreshed. Set `PCB2GCODE_WIKI_DIR` to use another folder.

The renderer and sanitizer are served locally. With Node 20.9+ installed, refresh those browser assets after updating dependencies:

```sh
npm ci
npm run build:wiki
npm run build:icons
```

Wiki illustrations linked to upstream sites load from their HTTPS URLs; relative images are served from the local wiki folder. The legacy manual keeps its original obsolete notice visible.

## Contact icons

The top bar uses the `bootstrap-icons` npm package. Its SVGs are embedded locally, so no Node process is needed at runtime. To refresh them:

```sh
npm ci
npm run build:icons
```

## Simulator

The 3D preview integrates [G-Code Simulator](https://github.com/federicovezzoli/gcode-simulator), an existing MIT-licensed CNC heightmap simulator. Its source is vendored at `vendor/gcode-simulator/`; upstream provenance and the local integration notes are in [`vendor/gcode-simulator/UPSTREAM.md`](vendor/gcode-simulator/UPSTREAM.md). The simulator accepts G0/G1/G2/G3 toolpaths, separates tool changes, and models material removal at configurable resolution. The app forwards generated G-code and stock dimensions to it in the browser.

The preview initially shows the finished board. Use **Play** or **Restart** to begin from uncut stock, or use the timeline to inspect intermediate cuts. Rapid paths are hidden by default and can be enabled in preview settings; the tool and its clearance are shown only on the active board face. Reloading any toolpath resets to the finished preview. The combined view reverses back-side machine-coordinate mirroring for display and aligns front and back copper on opposite faces of a shared board; original downloads are unchanged.

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

The visitor counter counts browsers using an anonymous cookie and stores its total in `.data/visitors.sqlite3`. Counts survive server restarts. Clearing cookies or using another browser counts as a new visitor. Set `PCB2GCODE_VISITOR_DB` to choose a different database path.

The generation indicator uses the Basic Striped design from [progress-bar-library](https://github.com/freethinked/progress-bar-library) (MIT), with animated stripes in the app’s green theme.

Backtracking is disabled by default with an explicit `--backtrack=0`. A blank Backtrack speed field means disabled; pcb2gcode’s implicit unlimited-retracing default is not used. Separate machining paths therefore retract to the configured Safe Z height. A positive Backtrack speed is an explicit opt-in to at-depth linking.
