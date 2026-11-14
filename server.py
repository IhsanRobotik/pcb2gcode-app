#!/usr/bin/env python3
"""Local web server and constrained pcb2gcode HTTP bridge."""

import json
import os
import re
import secrets
import sqlite3
import subprocess
import tempfile
import threading
from contextlib import closing
from email import policy
from email.parser import BytesParser
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from examples import discover_examples, resolve_example_file
from wiki_content import IMAGE_TYPES, wiki_file, wiki_pages

ROOT = Path(__file__).resolve().parent
SIMULATOR_ROOT = ROOT / "vendor/gcode-simulator/out"
PCB2GCODE = Path(os.environ.get("PCB2GCODE_BIN", str(ROOT.parent / "pcb2gcode/build/pcb2gcode"))).resolve()
HOST = os.environ.get("PCB2GCODE_HOST", "127.0.0.1")
PORT = int(os.environ.get("PCB2GCODE_PORT", "8080"))
MAX_REQUEST = 10 * 1024 * 1024
MAX_OUTPUT = 20 * 1024 * 1024
MAX_FILES = 20
EXAMPLES_ROOT = ROOT / "gerber"
WIKI_ROOT = Path(os.environ.get("PCB2GCODE_WIKI_DIR", str(ROOT / "pcb2gcode.wiki")))
FILE_EXTENSIONS = {".gbr", ".ger", ".gerber", ".pho", ".gtl", ".gbl", ".gm1", ".gko", ".drl", ".xln", ".txt", ".tap"}
ROLES = {"front": "--front", "back": "--back", "outline": "--outline", "drill": "--drill"}
UPLOAD_ROLES = {*ROLES, "npth"}
GENERATION_LOCK = threading.Lock()
VISITOR_DB = Path(os.environ.get("PCB2GCODE_VISITOR_DB", str(ROOT / ".data/visitors.sqlite3")))


def register_visitor(cookie_header, database=None):
    """Count a browser once using a random cookie; store no IP or browser details."""
    cookies = SimpleCookie()
    try:
        cookies.load(cookie_header or "")
    except CookieError:
        cookies = SimpleCookie()
    cookie = cookies.get("pcb2gcode_visitor")
    visitor_id = cookie.value if cookie else ""
    if not re.fullmatch(r"[0-9a-f]{32}", visitor_id):
        visitor_id = secrets.token_hex(16)
    database = Path(database) if database is not None else VISITOR_DB
    database.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database, timeout=10)) as connection, connection:
        connection.execute("CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY)")
        connection.execute("INSERT OR IGNORE INTO visitors (id) VALUES (?)", (visitor_id,))
        count = connection.execute("SELECT COUNT(*) FROM visitors").fetchone()[0]
    return count, visitor_id


def option_args(config, output_dir):
    """Validate form values and produce arguments from a fixed option allowlist."""
    if not isinstance(config, dict):
        raise ValueError("Missing job settings.")

    def num(key, low=None, high=None, required=False):
        value = config.get(key)
        if value is None and not required:
            return None
        if isinstance(value, bool):
            raise ValueError(f"Invalid value for {key}.")
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid value for {key}.") from None
        if not (value == value and abs(value) != float("inf")):
            raise ValueError(f"Invalid value for {key}.")
        if low is not None and value < low or high is not None and value > high:
            raise ValueError(f"{key} is outside the supported range.")
        return value

    def flag(key):
        value = config.get(key, False)
        if not isinstance(value, bool):
            raise ValueError(f"Invalid value for {key}.")
        return value

    basename = config.get("basename", "board")
    if not isinstance(basename, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", basename):
        raise ValueError("Output name must use 1–64 letters, numbers, dashes, or underscores.")
    sides = {}
    for key in ("drillSide", "cutSide"):
        side = config.get(key, "auto")
        if not isinstance(side, str) or side not in {"auto", "front", "back"}:
            raise ValueError("Choose a valid drill or outline side.")
        sides[key] = side

    tool_diameter = num("toolDiameter", 0.01, 25, True)
    isolation = num("isolation", 0, 100, True)
    feed_rate = num("feedRate", 0.1, 100000, True)
    pass_depth = num("passDepth", -100, -0.001, True)
    z_safe = num("zSafe", 0.01, 500, True)
    z_change = num("zchange", 0.01, 1000, True)
    backtrack = num("backtrack", 0, 100000)
    spinup = num("spinupTime", 0, 3600)
    mill_speed = num("millSpeed", 0, 100000)
    drill_speed = num("drillSpeed", 0, 100000)
    cut_feed = num("cutFeed", 0.1, 100000, True)
    cut_speed = num("cutSpeed", 0, 100000)
    diameters = config.get("millDiameters", [tool_diameter])
    if (not isinstance(diameters, list) or not 1 <= len(diameters) <= 10
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.001 <= v <= 25 for v in diameters)):
        raise ValueError("Enter up to 10 valid mill diameters greater than 0.")

    args = ["--noconfigfile=true", "--metric", "--metricoutput", f"--output-dir={output_dir}", f"--basename={basename}",
            f"--mill-diameters={','.join(format(v, '.8g') for v in diameters)}",
            f"--isolation-width={isolation:g}", f"--mill-feed={feed_rate:g}", f"--zwork={pass_depth:g}", f"--zsafe={z_safe:g}",
            f"--zchange={z_change:g}", f"--cut-feed={cut_feed:g}",
            f"--backtrack={0 if backtrack is None else backtrack:g}"]
    if spinup is not None:
        args.append(f"--spinup-time={spinup:g}")
    if flag("zchangeAbsolute"):
        args.append("--zchange-absolute=true")
    if mill_speed is not None:
        args.append(f"--mill-speed={mill_speed:g}")
    if drill_speed is not None:
        args.append(f"--drill-speed={drill_speed:g}")
    if cut_speed is not None:
        args.append(f"--cut-speed={cut_speed:g}")
    optional_numeric = {
        "millingOverlap": (0, 100, "--milling-overlap", "%"),
        "offset": (-100, 100, "--offset", ""),
        "millInfeed": (0.001, 100, "--mill-infeed", ""),
        "zdrill": (-100, -0.001, "--zdrill", ""),
        "drillFeed": (0.1, 100000, "--drill-feed", ""),
        "cutterDiameter": (0.01, 100, "--cutter-diameter", ""),
        "zcut": (-100, -0.001, "--zcut", ""),
        "cutInfeed": (0.001, 100, "--cut-infeed", ""),
        "bridges": (0, 100, "--bridges", ""),
        "bridgesNum": (0, 1000, "--bridgesnum", ""),
        "zBridges": (-100, 100, "--zbridges", ""),
        "millDrillThreshold": (0, 100, "--min-milldrill-hole-diameter", ""),
        "millDrillDiameter": (0.01, 100, "--milldrill-diameter", ""),
        "zMillDrill": (-100, -0.001, "--zmilldrill", ""),
        "millVertFeed": (0.1, 100000, "--mill-vertfeed", ""),
        "cutVertFeed": (0.1, 100000, "--cut-vertfeed", ""),
        "mirrorAxis": (-100000, 100000, "--mirror-axis", ""),
        "mirrorYAxis": (-100000, 100000, "--mirror-yaxis", ""),
        "xOffset": (-100000, 100000, "--x-offset", ""),
        "yOffset": (-100000, 100000, "--y-offset", ""),
        "tolerance": (0, 100, "--tolerance", ""),
        "optimise": (0, 100, "--optimise", ""),
        "pathFindingLimit": (0, 100000, "--path-finding-limit", ""),
        "g0VerticalSpeed": (0, 10000, "--g0-vertical-speed", ""),
        "g0HorizontalSpeed": (0, 10000, "--g0-horizontal-speed", ""),
        "tileX": (1, 100, "--tile-x", ""),
        "tileY": (1, 100, "--tile-y", ""),
        "spindownTime": (0, 3600, "--spindown-time", ""),
    }
    for key, (minimum, maximum, option, suffix) in optional_numeric.items():
        value = num(key, minimum, maximum)
        if value is not None:
            args.append(f"{option}={value:g}{suffix}")
    if flag("voronoi"):
        args.append("--voronoi=true")
    if flag("invertGerbers"):
        args.append("--invert-gerbers=true")
    if flag("zeroStart"):
        args.append("--zero-start=true")
    args.append(f"--eulerian-paths={str(flag('eulerian')).lower()}")
    args.extend([f"--drill-side={sides['drillSide']}", f"--cut-side={sides['cutSide']}"])
    bool_options = {
        "oneDrill": ("--onedrill", False), "nog81": ("--nog81", False), "noM6": ("--nom6", False),
        "fillOutline": ("--fill-outline", True), "alFront": ("--al-front", False), "alBack": ("--al-back", False),
        "tsp2opt": ("--tsp-2opt", True), "preserveThermals": ("--preserve-thermal-reliefs", True),
        "drawGerberLines": ("--draw-gerber-lines", False), "noG64": ("--nog64", False),
        "sanityChecks": ("--sanity-checks", False), "singleThread": ("--single-thread", False),
    }
    for key, (option, default) in bool_options.items():
        value = flag(key) if key in config else default
        if value or key in {"fillOutline", "tsp2opt", "preserveThermals"}:
            args.append(f"{option}={str(value).lower()}")
    direction = config.get("millFeedDirection", 0)
    if direction not in (0, 1):
        raise ValueError("Choose a valid milling direction.")
    if direction:
        args.append("--mill-feed-direction=1")
    for key, option in (("alX", "--al-x"), ("alY", "--al-y"), ("alProbeFeed", "--al-probefeed"),
                        ("alProbeVar", "--al-probevar")):
        value = num(key, 0.001, 100000)
        if value is not None:
            args.append(f"{option}={value:g}")
    for key, option in (("software", "--software"), ("alProbeCode", "--al-probecode"), ("alSetZZero", "--al-setzzero"),
                        ("alProbeOn", "--al-probe-on"), ("alProbeOff", "--al-probe-off")):
        value = config.get(key, "")
        if value:
            if not isinstance(value, str) or len(value) > 2000 or any(c in value for c in "\x00\r\n"):
                raise ValueError(f"Invalid value for {key}.")
            args.append(f"{option}={value}")
    if config.get("software") not in (None, "", "linuxcnc", "mach3", "mach4", "custom"):
        raise ValueError("Choose a supported autolevelling target.")
    drills = config.get("drillsAvailable", "")
    if drills:
        if not isinstance(drills, str) or len(drills) > 512 or not re.fullmatch(r"[0-9., ]+", drills):
            raise ValueError("Enter drill diameters as a comma-separated numeric list.")
        args.append(f"--drills-available={drills}")
    for key, option in (("preMillingCode", "--pre-milling-gcode"), ("postMillingCode", "--post-milling-gcode")):
        value = config.get(key, "")
        if value:
            if not isinstance(value, str) or len(value) > 2000 or "\x00" in value:
                raise ValueError(f"Invalid value for {key}.")
            args.append(f"{option}={value}")
    for key, option, limit in (("preamble", "--preamble", 8000), ("postamble", "--postamble", 8000), ("preambleText", "--preamble-text", 4000)):
        value = config.get(key, "")
        if value:
            if not isinstance(value, str) or len(value) > limit or "\x00" in value:
                raise ValueError(f"Invalid value for {key}.")
            suffix = {"preamble": "preamble-code.txt", "postamble": "postamble-code.txt", "preambleText": "preamble-text.txt"}[key]
            code_file = Path(output_dir) / suffix
            code_file.write_text(value, encoding="utf-8")
            args.append(f"{option}={code_file}")
    return args


def merge_excellon(paths, output):
    """Combine plated and non-plated Excellon files into one pcb2gcode input."""
    parsed = []
    for path in paths:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        try:
            header_end = next(i for i, line in enumerate(lines) if line.strip() == "%")
        except StopIteration:
            raise ValueError(f"{path.name} is not a supported M48 Excellon file (missing header terminator).") from None
        header, body = lines[:header_end], lines[header_end + 1:]
        unit = next((line.strip().upper() for line in header if line.strip().upper() in {"METRIC", "INCH"}), None)
        format_spec = next((line.strip().upper() for line in header if line.strip().upper().startswith("FMAT")), None)
        if not unit or not format_spec:
            raise ValueError(f"{path.name} must declare METRIC/INCH units and FMAT format.")
        parsed.append((path, header, body, unit, format_spec))
    if len({(item[3], item[4]) for item in parsed}) != 1:
        raise ValueError("PTH and NPTH drill files must use the same Excellon units and format.")

    tool_maps = []
    definitions = []
    next_tool = 1
    for _, header, _, _, _ in parsed:
        mapping = {}
        for line in header:
            match = re.match(r"\s*T(\d+)C([0-9]*\.?[0-9]+)", line, re.IGNORECASE)
            if match:
                mapping[match.group(1)] = next_tool
                definitions.append(f"T{next_tool}C{match.group(2)}")
                next_tool += 1
        tool_maps.append(mapping)

    first_header = parsed[0][1]
    header_lines = ["M48", "; Combined plated and non-plated drills"]
    for line in first_header:
        upper = line.strip().upper()
        if upper.startswith(("M48", "T")) or upper == "%" or "FILEFUNCTION" in upper:
            continue
        if upper in {"METRIC", "INCH"} or upper.startswith("FMAT") or "FORMAT=" in upper:
            header_lines.append(line)
    header_lines.extend(definitions)
    output_lines = [*header_lines, "%", "G90", "G05"]
    for (_, _, body, _, _), mapping in zip(parsed, tool_maps):
        for line in body:
            stripped = line.strip()
            if stripped.upper() in {"M30", "M00", "M02", "%", "M48"}:
                continue
            selected = re.fullmatch(r"T(\d+)", stripped, re.IGNORECASE)
            if selected:
                old_id = selected.group(1)
                if old_id not in mapping:
                    raise ValueError(f"Drill file selects undefined tool T{old_id}.")
                line = f"T{mapping[old_id]}"
            output_lines.append(line)
    output_lines.append("M30")
    output.write_text("\n".join(output_lines) + "\n", encoding="utf-8")
    return output


class Handler(BaseHTTPRequestHandler):
    server_version = "ToolpathStudio/1.0"

    def send_bytes(self, status, content_type, body, extra_headers=None, security_policy=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", security_policy or "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def respond(self, status, payload):
        self.send_bytes(status, "application/json; charset=utf-8", json.dumps(payload).encode("utf-8"))

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/wiki":
            try:
                pages = wiki_pages(WIKI_ROOT)
            except (OSError, UnicodeError, ValueError):
                return self.respond(503, {"error": "The local wiki could not be read."})
            return self.send_bytes(200, "application/json; charset=utf-8", json.dumps({"pages": pages}).encode("utf-8"), {"Cache-Control": "no-store"})
        if path == "/api/wiki/asset":
            relative = parse_qs(urlsplit(self.path).query).get("path", [""])[0]
            try:
                target = wiki_file(WIKI_ROOT, relative)
                content_type = IMAGE_TYPES.get(target.suffix.lower())
                if not content_type or target.stat().st_size > 20 * 1024 * 1024:
                    return self.respond(404, {"error": "Wiki image not found."})
                return self.send_bytes(200, content_type, target.read_bytes(), {"Cache-Control": "no-cache"})
            except (OSError, ValueError):
                return self.respond(404, {"error": "Wiki image not found."})
        if path in {"/wiki", "/wiki/"}:
            return self.send_bytes(200, "text/html; charset=utf-8", (ROOT / "wiki.html").read_bytes(), {"Cache-Control": "no-cache"},
                                   "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        if path in {"/wiki-runtime/marked.js", "/wiki-runtime/purify.js"}:
            target = ROOT / "vendor/wiki-runtime" / path.rsplit("/", 1)[-1]
            try:
                return self.send_bytes(200, "text/javascript; charset=utf-8", target.read_bytes(), {"Cache-Control": "no-cache"})
            except OSError:
                return self.respond(503, {"error": "Run npm run build:wiki to prepare the documentation renderer."})
        if path == "/api/visitors":
            try:
                count, visitor_id = register_visitor(self.headers.get("Cookie"))
            except (OSError, sqlite3.Error):
                return self.respond(503, {"error": "Visitor count is unavailable."})
            return self.send_bytes(200, "application/json; charset=utf-8", json.dumps({"visitors": count}).encode("utf-8"), {
                "Cache-Control": "no-store",
                "Set-Cookie": f"pcb2gcode_visitor={visitor_id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax",
            })
        if path == "/api/examples":
            try:
                catalog = discover_examples(EXAMPLES_ROOT)
            except OSError:
                return self.respond(503, {"error": "Included examples are unavailable."})
            return self.send_bytes(200, "application/json; charset=utf-8", json.dumps({"examples": catalog}).encode("utf-8"), {"Cache-Control": "no-store"})
        if path == "/api/examples/file":
            relative = parse_qs(urlsplit(self.path).query).get("path", [""])[0]
            try:
                target = resolve_example_file(EXAMPLES_ROOT, relative)
                if target.stat().st_size > MAX_REQUEST:
                    return self.respond(413, {"error": "Example file exceeds the 10 MB limit."})
                data = target.read_bytes()
            except (OSError, ValueError):
                return self.respond(404, {"error": "Example file not found."})
            return self.send_bytes(200, "application/octet-stream", data, {"Cache-Control": "no-store"})
        if path == "/api/health":
            try:
                result = subprocess.run([str(PCB2GCODE), "--version"], capture_output=True, text=True, timeout=10, check=False)
            except (OSError, subprocess.TimeoutExpired):
                return self.respond(503, {"error": "pcb2gcode is unavailable. Check PCB2GCODE_BIN and binary permissions."})
            if result.returncode:
                return self.respond(503, {"error": "pcb2gcode is unavailable."})
            return self.respond(200, {"ok": True, "version": result.stdout.strip()})

        if path in {"/simulator", "/simulator/"}:
            target = SIMULATOR_ROOT / "index.html"
            try:
                page = target.read_bytes()
            except OSError:
                return self.respond(503, {"error": "The CNC simulator has not been built. Run the build command in README.md."})
            return self.send_bytes(200, "text/html; charset=utf-8", page,
                                   {"Cache-Control": "no-cache"},
                                   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
        if path == "/favicon.ico":
            target = ROOT / "New Project.ico"
            if not target.is_file():
                return self.respond(404, {"error": "Not found."})
            return self.send_bytes(200, "image/x-icon", target.read_bytes(), {"Cache-Control": "no-cache"})
        if path.startswith("/_next/"):
            asset = path.lstrip("/")
            target = (SIMULATOR_ROOT / asset).resolve()
            if not target.is_relative_to(SIMULATOR_ROOT.resolve()) or not target.is_file():
                return self.respond(404, {"error": "Not found."})
            import mimetypes
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            cache = "public, max-age=31536000, immutable" if path.startswith("/_next/static/") else "no-cache"
            return self.send_bytes(200, content_type, target.read_bytes(), {"Cache-Control": cache},
                                   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")

        if path == "/":
            path = "/index.html"
        if path == "/features.txt":
            target = ROOT / "features.txt"
            content_type = "text/plain; charset=utf-8"
        elif path in {"/index.html", "/app.js", "/preview.js", "/styles.css", "/simulator.css", "/favicon.svg", "/New-Project.svg", "/wiki.js", "/wiki.css"}:
            target = ROOT / path.lstrip("/")
            content_type = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}[target.suffix]
        else:
            return self.respond(404, {"error": "Not found."})
        try:
            return self.send_bytes(200, content_type, target.read_bytes(), {"Cache-Control": "no-cache"})
        except OSError:
            return self.respond(404, {"error": "File not found."})

    def do_POST(self):
        if urlsplit(self.path).path != "/api/generate":
            return self.respond(404, {"error": "Not found."})
        origin = self.headers.get("Origin")
        if origin:
            origin_host = urlsplit(origin).netloc.lower()
            if not origin_host or origin_host != self.headers.get("Host", "").lower():
                return self.respond(403, {"error": "Cross-origin requests are not accepted."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.respond(400, {"error": "Invalid request length."})
        if not 1 <= length <= MAX_REQUEST:
            return self.respond(413, {"error": "Upload must be between 1 byte and 10 MB."})
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data;"):
            return self.respond(415, {"error": "Upload board files using multipart form data."})
        raw = self.rfile.read(length)
        try:
            message = BytesParser(policy=policy.default).parsebytes(
                b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw)
            config = None
            uploads = []
            for part in message.iter_parts():
                field = part.get_param("name", header="content-disposition")
                if field == "config":
                    config = json.loads(part.get_content())
                elif field in UPLOAD_ROLES and part.get_filename():
                    uploads.append((field, part.get_filename(), part.get_payload(decode=True) or b""))
        except (ValueError, TypeError, UnicodeError, AttributeError):
            return self.respond(400, {"error": "Could not read the uploaded files and settings."})
        if not uploads or len(uploads) > MAX_FILES:
            return self.respond(400, {"error": "Upload at least one and at most 20 board files."})
        roles = [item[0] for item in uploads]
        if len(set(roles)) != len(roles):
            return self.respond(400, {"error": "Choose one file for each copper, profile, and drill layer."})
        total = sum(len(data) for _, _, data in uploads)
        if total == 0 or total > MAX_REQUEST:
            return self.respond(413, {"error": "Board files must total between 1 byte and 10 MB."})

        if not GENERATION_LOCK.acquire(blocking=False):
            return self.respond(429, {"error": "Another job is generating. Please wait for it to finish."})
        try:
            with tempfile.TemporaryDirectory(prefix="toolpath-job-") as temp:
                args = option_args(config, temp)
                input_paths = {}
                for role, filename, data in uploads:
                    clean = Path(filename.replace("\\", "/")).name
                    if not re.fullmatch(r"[A-Za-z0-9_. -]{1,120}", clean) or Path(clean).suffix.lower() not in FILE_EXTENSIONS:
                        return self.respond(400, {"error": "Use a safe filename with a supported Gerber, Excellon, or text extension."})
                    if clean in input_paths:
                        return self.respond(400, {"error": "Uploaded files must have distinct filenames."})
                    target = Path(temp) / clean
                    target.write_bytes(data)
                    input_paths[role] = target
                for role in ("front", "back", "outline"):
                    if role in input_paths:
                        args.append(f"{ROLES[role]}={input_paths[role]}")
                if "drill" in input_paths and "npth" in input_paths:
                    merged = merge_excellon([input_paths["drill"], input_paths["npth"]], Path(temp) / "combined-drill.drl")
                    args.append(f"--drill={merged}")
                elif "drill" in input_paths:
                    args.append(f"--drill={input_paths['drill']}")
                elif "npth" in input_paths:
                    args.append(f"--drill={input_paths['npth']}")
                try:
                    result = subprocess.run([str(PCB2GCODE), *args], cwd=temp, capture_output=True, text=True, timeout=180, check=False)
                except subprocess.TimeoutExpired:
                    return self.respond(504, {"error": "Generation timed out after 180 seconds."})
                except OSError:
                    return self.respond(503, {"error": "Could not run pcb2gcode. Check the binary path and permissions."})
                inputs = {Path(filename.replace("\\", "/")).name for _, filename, _ in uploads}
                outputs = []
                output_size = 0
                for path in sorted(Path(temp).iterdir()):
                    if path.is_file() and path.name not in inputs and path.suffix.lower() in {".ngc", ".gcode"}:
                        size = path.stat().st_size
                        output_size += size
                        if output_size > MAX_OUTPUT:
                            return self.respond(413, {"error": "Generated G-code exceeds the 20 MB response limit."})
                        outputs.append({"name": path.name, "content": path.read_text(encoding="utf-8", errors="replace")})
                if result.returncode != 0 or not outputs:
                    detail = (result.stderr or result.stdout or "No G-code files were generated.")[-5000:]
                    return self.respond(422, {"error": "pcb2gcode could not generate this job.", "details": detail})
                return self.respond(200, {"files": outputs, "logs": (result.stdout or result.stderr or "Generation completed.")[-8000:]})
        except ValueError as exc:
            return self.respond(400, {"error": str(exc)})
        except (OSError, KeyError) as exc:
            return self.respond(500, {"error": "The job could not be prepared.", "details": str(exc)})
        finally:
            GENERATION_LOCK.release()

    def log_message(self, fmt, *args):
        # Avoid writing uploaded file names and form values into routine logs.
        print(f"{self.address_string()} {fmt % args}", flush=True)


def main():
    if not PCB2GCODE.is_file() or not os.access(PCB2GCODE, os.X_OK):
        print(f"pcb2gcode executable not found: {PCB2GCODE}\nSet PCB2GCODE_BIN to its full path.", flush=True)
        raise SystemExit(1)
    print(f"Toolpath Studio at http://{HOST}:{PORT} · {PCB2GCODE}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
