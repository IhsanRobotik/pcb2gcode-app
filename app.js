const roles = ["front", "back", "outline", "drill", "npth", "job"];
const engineRoles = new Set(["front", "back", "outline", "drill", "npth"]);
const selectedFiles = new Map();
const $ = (selector) => document.querySelector(selector);
const fields = new Proxy({}, { get: (_, name) => document.querySelector(`[name="${String(name)}"]`) });
let units = "metric";
let lastOutput = [];
let lastGenerationConfig = null;
let generatedUrls = [];
let boardMetadata = null;
let pendingSimulatorPayload = null;
let simulatorLoaded = false;
let simulatorRequested = false;
let generationVersion = 0;
let generationRunning = false;
let exampleLoading = false;
let fileRevision = 0;
let lastGenerationSignature = "";

function safeName(name) { return name.replace(/[<>"']/g, ""); }
function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 2600);
}
function refreshFiles() {
  let total = 0;
  for (const role of roles) {
    const file = selectedFiles.get(role);
    const slot = document.querySelector(`[data-role="${role}"]`);
    const small = slot.querySelector(".slot-copy small");
    slot.classList.toggle("has-file", Boolean(file));
    if (file) {
      total += file.size;
      small.textContent = `${safeName(file.name)} · ${formatBytes(file.size)}`;
    } else {
      const copy = {
        front: "Top copper traces", back: "Bottom copper traces", outline: "Edge cuts / profile", drill: "Excellon plated holes",
        npth: "Excellon non-plated holes", job: "Optional board thickness source",
      };
      small.textContent = copy[role];
    }
  }
  const count = [...selectedFiles.keys()].filter((role) => engineRoles.has(role)).length;
  $("#readyText").textContent = count ? `${count} layer${count === 1 ? "" : "s"} ready · ${formatBytes(total)}` : "Add a board file to get started";
  $("#readyHint").textContent = count ? "Outer copper, outline and drill files are processed locally." : "Your files stay in this local workspace.";
  $(".ready-state").classList.toggle("ready", count > 0);
  updateGenerationButton();
}
function formatBytes(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }

document.querySelectorAll(".file-slot input").forEach((input) => {
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) {
      const role = input.closest(".file-slot").dataset.role;
      const total = [...selectedFiles.entries()].reduce((size, [key, item]) => size + (key === role ? 0 : item.size), file.size);
      if (total > 10 * 1024 * 1024) { toast("Board files must total 10 MB or less"); input.value = ""; return; }
      selectedFiles.set(role, file); fileRevision++;
      if (role === "job") await readJobFile(file);
    }
    input.value = "";
    refreshFiles();
    if (file) markGenerationDirty();
  });
});
document.querySelectorAll(".file-slot").forEach((slot) => {
  slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("has-file"); });
  slot.addEventListener("dragleave", () => { if (!selectedFiles.has(slot.dataset.role)) slot.classList.remove("has-file"); });
  slot.addEventListener("drop", async (e) => {
    e.preventDefault(); const file = e.dataTransfer.files[0];
    if (file) {
      const role = slot.dataset.role;
      const total = [...selectedFiles.entries()].reduce((size, [key, item]) => size + (key === role ? 0 : item.size), file.size);
      if (total > 10 * 1024 * 1024) { toast("Board files must total 10 MB or less"); return; }
      selectedFiles.set(role, file); fileRevision++; refreshFiles();
      if (role === "job") await readJobFile(file);
      markGenerationDirty();
    }
  });
});

async function readJobFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const general = data.GeneralSpecs || {};
    const projectName = general.ProjectId?.Name;
    const thickness = Number(general.BoardThickness);
    const sizeX = Number(general.Size?.X), sizeY = Number(general.Size?.Y);
    boardMetadata = { projectName, thickness, sizeX, sizeY };
    if (Number.isFinite(thickness) && thickness > 0) fields.boardThickness.value = units === "imperial" ? (thickness / 25.4).toFixed(4) : thickness;
    renderBoardMetadata();
  } catch {
    boardMetadata = null;
    renderBoardMetadata();
    toast("Could not read this KiCad board job file");
  }
}

function renderBoardMetadata() {
  const card = $("#boardMetadataCard"), details = $("#boardMetadataDetails");
  if (!boardMetadata) { card.hidden = true; return; }
  card.hidden = false;
  details.replaceChildren();
  const summary = document.createElement("div"); summary.className = "board-meta-summary";
  summary.innerHTML = `<strong></strong><small></small>`;
  summary.querySelector("strong").textContent = boardMetadata.projectName || "PCB board job";
  summary.querySelector("small").textContent = `${Number.isFinite(boardMetadata.sizeX) && Number.isFinite(boardMetadata.sizeY) ? `${boardMetadata.sizeX} × ${boardMetadata.sizeY} mm board` : "Board dimensions unavailable"} · ${boardMetadata.thickness || "?"} mm thickness`;
  details.append(summary);
}

function number(name, fallback = null) {
  const value = fields[name]?.value;
  if (value === "" || value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Enter a valid number for ${name}.`);
  return parsed;
}
function checked(name) { return Boolean(fields[name]?.checked); }
function fromDisplay(value) { return units === "imperial" && value !== null ? value * 25.4 : value; }
function collectConfig() {
  const name = fields.basename.value.trim();
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Output name must use 1–64 letters, numbers, dashes, or underscores.");
  const overlap = number("millingOverlap");
  if (overlap < 0 || overlap > 100) throw new Error("Milling overlap must be between 0 and 100%.");
  const diameterText = fields.millDiameters.value.trim();
  const diameters = diameterText ? diameterText.split(",").map((v) => v.trim()).filter(Boolean).map(Number) : [number("toolDiameter")];
  if (!diameters.length || diameters.some((v) => !Number.isFinite(v) || v <= 0 || v > 25)) throw new Error("Enter one or more valid mill diameters greater than 0.");
  return {
    toolDiameter: fromDisplay(number("toolDiameter")), isolation: fromDisplay(number("isolation")),
    feedRate: units === "imperial" ? number("feedRate") * 25.4 : number("feedRate"),
    passDepth: fromDisplay(number("passDepth")), zSafe: fromDisplay(number("zSafe")),
    millSpeed: number("millSpeed"), millDiameters: diameters.map(fromDisplay),
    millingOverlap: overlap, offset: fromDisplay(number("offset")), millInfeed: fromDisplay(number("millInfeed")),
    voronoi: checked("voronoi"), invertGerbers: checked("invertGerbers"),
    zdrill: fromDisplay(number("zdrill")), drillFeed: units === "imperial" ? number("drillFeed") * 25.4 : number("drillFeed"), drillSpeed: number("drillSpeed"),
    cutterDiameter: fromDisplay(number("cutterDiameter")), zcut: fromDisplay(number("zcut")),
    cutInfeed: fromDisplay(number("cutInfeed")), cutFeed: units === "imperial" ? number("cutFeed") * 25.4 : number("cutFeed"), cutSpeed: number("cutSpeed"), bridges: fromDisplay(number("bridges")),
    drillSide: fields.drillSide.value, cutSide: fields.cutSide.value, mirrorAxis: fromDisplay(number("mirrorAxis")),
    tolerance: fromDisplay(number("tolerance")), xOffset: fromDisplay(number("xOffset")), yOffset: fromDisplay(number("yOffset")), mirrorYAxis: fromDisplay(number("mirrorYAxis")), zchange: fromDisplay(number("zchange")), spinupTime: number("spinupTime"),
    boardThickness: fromDisplay(number("boardThickness", 1.6)),
    zchangeAbsolute: checked("zchangeAbsolute"), basename: name, zeroStart: checked("zeroStart"), eulerian: checked("eulerian"),
    millDrillThreshold: fromDisplay(number("millDrillThreshold")), millDrillDiameter: fromDisplay(number("millDrillDiameter")), zMillDrill: fromDisplay(number("zMillDrill")),
    millVertFeed: units === "imperial" ? number("millVertFeed") * 25.4 : number("millVertFeed"),
    cutVertFeed: units === "imperial" ? number("cutVertFeed") * 25.4 : number("cutVertFeed"), bridgesNum: number("bridgesNum"), zBridges: fromDisplay(number("zBridges")),
    drillsAvailable: fields.drillsAvailable.value.trim() ? fields.drillsAvailable.value.split(",").map((v) => (units === "imperial" ? Number(v.trim()) * 25.4 : Number(v.trim())).toString()).join(", ") : "", oneDrill: checked("oneDrill"), nog81: checked("nog81"), noM6: checked("noM6"), fillOutline: checked("fillOutline"),
    software: fields.software.value, alX: fromDisplay(number("alX")), alY: fromDisplay(number("alY")), alProbeFeed: units === "imperial" ? number("alProbeFeed") * 25.4 : number("alProbeFeed"),
    alProbeCode: fields.alProbeCode.value.trim(), alProbeVar: number("alProbeVar"), alSetZZero: fields.alSetZZero.value.trim(), alFront: checked("alFront"), alBack: checked("alBack"),
    alProbeOn: fields.alProbeOn.value.trim(), alProbeOff: fields.alProbeOff.value.trim(),
    optimise: fromDisplay(number("optimise")), pathFindingLimit: number("pathFindingLimit"), g0VerticalSpeed: number("g0VerticalSpeed"), g0HorizontalSpeed: number("g0HorizontalSpeed"),
    backtrack: number("backtrack"), tileX: number("tileX"), tileY: number("tileY"), spindownTime: number("spindownTime"), millFeedDirection: number("millFeedDirection"),
    tsp2opt: checked("tsp2opt"), preserveThermals: checked("preserveThermals"), drawGerberLines: checked("drawGerberLines"), noG64: checked("noG64"), sanityChecks: checked("sanityChecks"), singleThread: checked("singleThread"),
    preMillingCode: fields.preMillingCode.value, postMillingCode: fields.postMillingCode.value, preamble: fields.preamble.value, postamble: fields.postamble.value, preambleText: fields.preambleText.value,
  };
}

function simulatorToolpath(source) {
  const lines = source.split(/\r?\n/);
  const withToolStops = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*M0?6\b/i.test(line) && withToolStops.length && /\(\s*MSG.*CHANGE\s+TOOL/i.test(withToolStops.at(-1))) {
      withToolStops[withToolStops.length - 1] = `M0 ${withToolStops.at(-1)}`;
      continue;
    }
    withToolStops.push(line);
  }

  let absolute = true, x = 0, y = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const codeOf = (line) => line.split(";")[0].replace(/\([^)]*\)/g, "");
  for (const line of withToolStops) {
    const code = codeOf(line).toUpperCase();
    const gCodes = [...code.matchAll(/\bG\s*([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
    if (gCodes.includes(90)) absolute = true;
    if (gCodes.includes(91)) absolute = false;
    for (const match of code.matchAll(/\b([XY])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g)) {
      const value = Number(match[2]);
      if (absolute) { if (match[1] === "X") x = value; else y = value; }
      else if (match[1] === "X") x += value; else y += value;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) throw new Error("This G-code has no XY toolpath to simulate.");

  const margin = 5, shiftX = margin - minX, shiftY = margin - minY;
  absolute = true;
  const shifted = withToolStops.map((line) => {
    const commentAt = line.search(/[;(]/);
    const code = commentAt < 0 ? line : line.slice(0, commentAt);
    const comment = commentAt < 0 ? "" : line.slice(commentAt);
    const upper = code.toUpperCase();
    const gCodes = [...upper.matchAll(/\bG\s*([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
    if (gCodes.includes(90)) absolute = true;
    if (gCodes.includes(91)) absolute = false;
    if (!absolute) return line;
    return code.replace(/\b([XY])\s*([+-]?(?:\d+\.?\d*|\.\d+))/gi, (_, axis, raw) => {
      const shiftedValue = Number(raw) + (axis.toUpperCase() === "X" ? shiftX : shiftY);
      return `${axis}${shiftedValue.toFixed(4)}`;
    }) + comment;
  }).join("\n");
  return {
    gcode: shifted,
    stockWidth: Math.max(1, maxX - minX + margin * 2),
    stockDepth: Math.max(1, maxY - minY + margin * 2),
  };
}

function toolpathRole(name) {
  if (/front/i.test(name)) return { order: 0, label: "front copper" };
  if (/back/i.test(name)) return { order: 1, label: "back copper" };
  if (/drill/i.test(name)) return { order: 2, label: "drill" };
  if (/outline|profile|cut/i.test(name)) return { order: 3, label: "board outline" };
  return { order: 4, label: "toolpath" };
}

function simulatorFilePreview(output) {
  const role = toolpathRole(output.name);
  return simulatorToolpath(`M0 (MSG, Change tool for ${role.label})\n${output.content}`);
}

function combineToolpathFiles(outputs, config = lastGenerationConfig || collectConfig()) {
  const hasFront = outputs.some((output) => toolpathRole(output.name).order === 0);
  const hasBack = outputs.some((output) => toolpathRole(output.name).order === 1);
  const workSide = (side) => side === "back" || (side === "auto" && !hasFront && hasBack) ? "back" : "front";
  return [...outputs]
    .sort((a, b) => toolpathRole(a.name).order - toolpathRole(b.name).order || a.name.localeCompare(b.name))
    .map((output) => {
      const role = toolpathRole(output.name);
      const sourceSide = role.order === 1 ? "back" : role.order === 2 ? workSide(config.drillSide) : role.order === 3 ? workSide(config.cutSide) : "front";
      const content = sourceSide === "back" ? PCBPreview.reflectToolpath(output.content, { axis: Number(config.mirrorAxis) || 0, flipY: Boolean(config.mirrorYAxis) }) : output.content;
      return `M0 (MSG, Change tool for ${role.label})\n${content.trim()}`;
    })
    .join("\n\n");
}

function sendToSimulator(payload, scroll = true) {
  payload = { ...payload, downloadExtension: $("#downloadExtension").value };
  const frame = $("#simulatorFrame"), panel = $("#simulatorPanel");
  pendingSimulatorPayload = payload;
  panel.hidden = false;
  if (scroll) panel.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!simulatorRequested) {
    simulatorRequested = true;
    frame.src = "/simulator/?embedded=1";
  }
  if (simulatorLoaded) frame.contentWindow.postMessage(payload, location.origin);
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== $("#simulatorFrame").contentWindow) return;
  if (event.data?.type === "pcb2gcode:scroll") {
    if (typeof event.data.deltaY === "number" && Number.isFinite(event.data.deltaY)) {
      window.scrollBy({ top: Math.max(-window.innerHeight, Math.min(window.innerHeight, event.data.deltaY)), behavior: "instant" });
    }
    return;
  }
  if (event.data?.type !== "pcb2gcode:ready") return;
  simulatorLoaded = true;
  $("#simulatorFrame").contentWindow.postMessage({ type: "pcb2gcode:theme", theme: document.body.classList.contains("light") ? "light" : "dark" }, location.origin);
  if (pendingSimulatorPayload) $("#simulatorFrame").contentWindow.postMessage(pendingSimulatorPayload, location.origin);
});

function downloadFilename(name) {
  return name.replace(/\.(?:ngc|gcode|nc)$/i, "") + "." + $("#downloadExtension").value;
}

$("#downloadExtension").value = localStorage.getItem("toolpath-download-extension") === "nc" ? "nc" : "ngc";
$("#downloadExtension").addEventListener("change", () => {
  const downloadExtension = $("#downloadExtension").value;
  localStorage.setItem("toolpath-download-extension", downloadExtension);
  document.querySelectorAll("[data-output-name]").forEach((element) => {
    const name = downloadFilename(element.dataset.outputName);
    if (element instanceof HTMLAnchorElement) element.download = name;
    else element.textContent = name;
  });
  if (pendingSimulatorPayload) pendingSimulatorPayload.downloadExtension = downloadExtension;
  if (simulatorLoaded) $("#simulatorFrame").contentWindow.postMessage({ type: "pcb2gcode:download-format", downloadExtension }, location.origin);
});

function displayOutputs(result) {
  generatedUrls.forEach(URL.revokeObjectURL);
  generatedUrls = [];
  lastOutput = result.files || [];
  $("#viewCombinedToolpath").hidden = lastOutput.length < 2;
  const list = $("#outputList"); list.replaceChildren();
  let totalMoves = 0;
  for (const output of lastOutput) {
    const row = document.createElement("article"); row.className = "output-file";
    const blob = new Blob([output.content], { type: "text/plain;charset=utf-8" });
    const moves = (output.content.match(/^\s*G0*[013]\b/gim) || []).length; totalMoves += moves;
    const main = document.createElement("div"); main.className = "output-file-main";
    const description = document.createElement("div"); description.className = "output-file-copy";
    const kind = document.createElement("span"); kind.className = "output-operation";
    kind.textContent = /drill/i.test(output.name) ? "DRILLING" : /outline|profile|cut/i.test(output.name) ? "BOARD PROFILE" : /back/i.test(output.name) ? "BACK COPPER" : /front/i.test(output.name) ? "FRONT COPPER" : "TOOLPATH";
    const filename = document.createElement("strong"); filename.dataset.outputName = output.name; filename.textContent = downloadFilename(output.name);
    const details = document.createElement("small"); details.textContent = `${moves.toLocaleString()} motion blocks · ${formatBytes(blob.size)}`;
    description.append(kind, filename, details); main.append(description);
    const actions = document.createElement("div"); actions.className = "output-actions";
    const simulate = document.createElement("button"); simulate.type = "button"; simulate.className = "simulate-button"; simulate.textContent = "Preview Toolpath";
    simulate.addEventListener("click", () => {
      const prepared = simulatorFilePreview(output);
      sendToSimulator({
        type: "pcb2gcode:load", name: output.name, gcode: prepared.gcode,
        stockWidth: prepared.stockWidth, stockDepth: prepared.stockDepth,
        stockHeight: (Number(fields.boardThickness.value) || 1.6) * (units === "imperial" ? 25.4 : 1),
      }, true);
    });
    const link = document.createElement("a"); link.className = "download-button"; link.href = URL.createObjectURL(blob); generatedUrls.push(link.href);
    link.dataset.outputName = output.name; link.download = downloadFilename(output.name); link.textContent = "Download";
    actions.append(simulate, link); row.append(main, actions); list.append(row);
  }
  $("#outputCount").textContent = `${lastOutput.length} FILE${lastOutput.length === 1 ? "" : "S"}`;
  $("#outputSummary").textContent = `${lastOutput.length} file${lastOutput.length === 1 ? "" : "s"} ready · ${totalMoves.toLocaleString()} motion blocks · the simulator is loaded below.`;
  $("#engineLog").textContent = result.logs || "Generation completed.";
  $("#outputCard").hidden = false;
  refreshFiles();
  const previewFile = lastOutput.find((file) => /_front\.(?:ngc|gcode)$/i.test(file.name)) || lastOutput.find((file) => /_back\.(?:ngc|gcode)$/i.test(file.name)) || lastOutput[0];
  if (previewFile) {
    const prepared = simulatorFilePreview(previewFile);
    sendToSimulator({
      type: "pcb2gcode:load", name: previewFile.name, gcode: prepared.gcode,
      stockWidth: prepared.stockWidth, stockDepth: prepared.stockDepth,
      stockHeight: (Number(fields.boardThickness.value) || 1.6) * (units === "imperial" ? 25.4 : 1),
    }, false);
  }
}

$("#viewCombinedToolpath").addEventListener("click", () => {
  if (lastOutput.length < 2) return;
  try {
    const prepared = simulatorToolpath(combineToolpathFiles(lastOutput));
    sendToSimulator({
      type: "pcb2gcode:load", name: "Combined toolpath", gcode: prepared.gcode,
      stockWidth: prepared.stockWidth, stockDepth: prepared.stockDepth,
      stockHeight: (Number(fields.boardThickness.value) || 1.6) * (units === "imperial" ? 25.4 : 1),
    }, true);
  } catch (error) {
    toast(error.message || "Could not combine the generated toolpaths.");
  }
});

function hasBoardFiles() {
  return [...selectedFiles.keys()].some((role) => engineRoles.has(role));
}
function updateGenerationButton() {
  const button = $("#generateButton");
  button.disabled = generationRunning || exampleLoading || !hasBoardFiles();
  button.dataset.busy = String(generationRunning);
  button.setAttribute("aria-busy", String(generationRunning));
  button.querySelector(".generate-label").textContent = generationRunning ? "Generating…" : lastOutput.length ? "Re-generate toolpaths" : "Generate toolpaths";
}
function setGenerationStatus(text, state = "idle") {
  $("#generationStatus").textContent = text;
  $("#generationStatus").dataset.state = state;
  $("#outputCard").setAttribute("aria-busy", String(state === "busy"));
  $("#generationProgress").hidden = state !== "busy";
  updateGenerationButton();
}
function markGenerationDirty() {
  const values = [...$("#settings").querySelectorAll("input, select, textarea")].map((input) => [input.name, input.type === "checkbox" ? input.checked : input.value]);
  const signature = JSON.stringify([fileRevision, units, values]);
  if (signature === lastGenerationSignature) return;
  lastGenerationSignature = signature;
  generationVersion++;
  $("#errorBox").hidden = true;
  if (lastOutput.length) $("#outputSummary").textContent = "Previous toolpaths · re-generate to apply your changes.";
  setGenerationStatus(generationRunning ? "Generating previous settings…" : hasBoardFiles() ? lastOutput.length ? "Changes ready to regenerate" : "Ready to generate" : "Waiting for board files", generationRunning ? "busy" : "idle");
}
async function generateToolpaths() {
  if (generationRunning || exampleLoading || !hasBoardFiles()) return;
  generationRunning = true;
  const version = generationVersion;
  const error = $("#errorBox");
  error.hidden = true;
  setGenerationStatus("Generating…", "busy");
  try {
    const config = collectConfig();
    const data = new FormData(); data.append("config", JSON.stringify(config));
    for (const [role, file] of selectedFiles) if (engineRoles.has(role)) data.append(role, file, file.name);
    const response = await fetch("/api/generate", { method: "POST", body: data });
    const result = await response.json();
    if (version !== generationVersion || exampleLoading) return;
    if (!response.ok) throw new Error([result.error, result.details].filter(Boolean).join("\n"));
    lastGenerationConfig = config;
    displayOutputs(result);
    setGenerationStatus(`${result.files.length} file${result.files.length === 1 ? "" : "s"} ready`, "ready");
  } catch (err) {
    if (version !== generationVersion || exampleLoading) return;
    error.textContent = err.message || "The job could not be generated."; error.hidden = false;
    setGenerationStatus("Generation failed", "error");
  } finally {
    generationRunning = false;
    if (exampleLoading) setGenerationStatus("Loading example…", "busy");
    else if (version !== generationVersion) setGenerationStatus(hasBoardFiles() ? "Inputs changed · generate again" : "Waiting for board files");
    else updateGenerationButton();
  }
}
$("#generateButton").addEventListener("click", generateToolpaths);
$("#settings").addEventListener("input", markGenerationDirty);
$("#settings").addEventListener("change", markGenerationDirty);

const browserColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
let selectedTheme = localStorage.getItem("toolpath-theme");
if (!["light", "dark"].includes(selectedTheme)) selectedTheme = null;
function applyTheme(theme) {
  const isLight = theme === "light";
  document.body.classList.toggle("light", isLight);
  const action = isLight ? "Switch to dark mode" : "Switch to light mode";
  $("#themeButton").setAttribute("aria-label", action);
  $("#themeButton").title = action;
  $("meta[name='theme-color']").content = isLight ? "#f2f4f0" : "#101211";
  if (simulatorLoaded) $("#simulatorFrame").contentWindow.postMessage({ type: "pcb2gcode:theme", theme }, location.origin);
}
applyTheme(selectedTheme || (browserColorScheme.matches ? "dark" : "light"));
$("#themeButton").addEventListener("click", () => {
  selectedTheme = document.body.classList.contains("light") ? "dark" : "light";
  localStorage.setItem("toolpath-theme", selectedTheme);
  applyTheme(selectedTheme);
});
browserColorScheme.addEventListener("change", (event) => {
  if (!selectedTheme) applyTheme(event.matches ? "dark" : "light");
});
window.addEventListener("storage", (event) => {
  if (event.key !== "toolpath-theme") return;
  selectedTheme = ["light", "dark"].includes(event.newValue) ? event.newValue : null;
  applyTheme(selectedTheme || (browserColorScheme.matches ? "dark" : "light"));
});

const unitConversions = ["toolDiameter", "isolation", "passDepth", "zSafe", "offset", "millInfeed", "zdrill", "cutterDiameter", "zcut", "cutInfeed", "bridges", "mirrorAxis", "mirrorYAxis", "xOffset", "yOffset", "tolerance", "zchange", "boardThickness", "millDrillThreshold", "millDrillDiameter", "zMillDrill", "zBridges", "millVertFeed", "cutVertFeed", "alX", "alY", "alProbeFeed"];
document.querySelectorAll("[data-units]").forEach((button) => button.addEventListener("click", () => {
  const next = button.dataset.units; if (next === units) return;
  const factor = next === "imperial" ? 1 / 25.4 : 25.4;
  for (const name of unitConversions) { const input = fields[name]; if (input?.value) input.value = (Number(input.value) * factor).toFixed(4).replace(/\.?0+$/, ""); }
  if (next === "imperial") { for (const key of ["feedRate", "drillFeed", "cutFeed", "millVertFeed", "cutVertFeed", "alProbeFeed"]) if (fields[key].value) fields[key].value = (Number(fields[key].value) / 25.4).toFixed(2); for (const key of ["millDiameters", "drillsAvailable"]) if (fields[key].value.trim()) fields[key].value = fields[key].value.split(",").map(v => (Number(v.trim()) / 25.4).toFixed(4)).join(", "); }
  else { for (const key of ["feedRate", "drillFeed", "cutFeed", "millVertFeed", "cutVertFeed", "alProbeFeed"]) if (fields[key].value) fields[key].value = (Number(fields[key].value) * 25.4).toFixed(0); for (const key of ["millDiameters", "drillsAvailable"]) if (fields[key].value.trim()) fields[key].value = fields[key].value.split(",").map(v => (Number(v.trim()) * 25.4).toFixed(2)).join(", "); }
  units = next;
  document.querySelectorAll("[data-units]").forEach((item) => item.classList.toggle("selected", item === button));
  document.querySelectorAll(".unit-label").forEach((label) => { if (["feedRate", "drillFeed", "cutFeed", "millVertFeed", "cutVertFeed", "alProbeFeed"].includes(label.previousElementSibling.name)) label.textContent = next === "metric" ? "mm/min" : "in/min"; else if (label.textContent === "mm" || label.textContent === "in") label.textContent = next === "metric" ? "mm" : "in"; });
  markGenerationDirty();
}));

let includedExamples = [];
const exampleRoleLabels = { front: "front copper", back: "back copper", outline: "outline", drill: "plated drill", npth: "non-plated drill", job: "board metadata" };
function updateExampleSelection() {
  const example = includedExamples.find((item) => item.id === $("#exampleBoard").value);
  $("#exampleHint").textContent = example
    ? `${example.files.map((file) => exampleRoleLabels[file.role]).join(" · ")}. Loading replaces the selected board files.`
    : "Choose a sample board, or upload your own files below. Generate toolpaths when you are ready.";
}
async function refreshExamples() {
  const select = $("#exampleBoard"), refresh = $("#refreshExamplesButton");
  const previous = select.value;
  refresh.disabled = true;
  select.disabled = true;
  try {
    const response = await fetch("/api/examples", { cache: "no-store" });
    if (!response.ok) throw new Error("Included examples could not be loaded.");
    const result = await response.json();
    if (!Array.isArray(result.examples)) throw new Error("Invalid example catalog.");
    includedExamples = result.examples;
    select.replaceChildren(new Option(includedExamples.length ? "Choose an example board…" : "No included examples found", ""));
    for (const example of includedExamples) select.add(new Option(example.name, example.id));
    if (includedExamples.some((item) => item.id === previous)) select.value = previous;
    select.disabled = includedExamples.length === 0;
    updateExampleSelection();
    if (!includedExamples.length) $("#exampleHint").textContent = "No examples available yet. You can still upload your own board files below.";
  } catch (error) {
    includedExamples = [];
    select.replaceChildren(new Option("Examples unavailable", ""));
    $("#exampleHint").textContent = "Could not load examples. Refresh to try again, or upload your own files below.";
  } finally {
    refresh.disabled = false;
  }
}
$("#exampleBoard").addEventListener("change", () => { updateExampleSelection(); loadSelectedExample(); });
$("#refreshExamplesButton").addEventListener("click", refreshExamples);
async function loadSelectedExample() {
  const example = includedExamples.find((item) => item.id === $("#exampleBoard").value);
  if (!example) return;
  let loadedExample = false;
  exampleLoading = true;
  generationVersion++;
  setGenerationStatus("Loading example…", "busy");
  $("#exampleBoard").disabled = true;
  $("#refreshExamplesButton").disabled = true;
  try {
    if (example.files.reduce((size, file) => size + file.size, 0) > 10 * 1024 * 1024) throw new Error("Board files must total 10 MB or less.");
    const assignedRoles = new Set();
    for (const file of example.files) {
      if (assignedRoles.has(file.role)) throw new Error(`This example has multiple ${exampleRoleLabels[file.role]} files. Place each board variant in its own subfolder.`);
      assignedRoles.add(file.role);
    }
    const loaded = await Promise.all(example.files.map(async (entry) => {
      const response = await fetch(entry.url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load ${entry.name}. Refresh the examples and try again.`);
      const safeFilename = entry.name.normalize("NFKD").replace(/[^A-Za-z0-9_. -]/g, "_").slice(-120);
      return [entry.role, new File([await response.blob()], safeFilename, { type: "application/octet-stream" })];
    }));
    if (loaded.reduce((size, [, file]) => size + file.size, 0) > 10 * 1024 * 1024) throw new Error("Board files must total 10 MB or less.");
    selectedFiles.clear();
    for (const [role, file] of loaded) selectedFiles.set(role, file);
    fileRevision++;
    boardMetadata = null; renderBoardMetadata();
    if (selectedFiles.has("job")) await readJobFile(selectedFiles.get("job"));
    generatedUrls.forEach(URL.revokeObjectURL); generatedUrls = []; lastOutput = [];
    pendingSimulatorPayload = null;
    $("#outputCard").hidden = true;
    $("#outputList").replaceChildren();
    $("#engineLog").textContent = "";
    $("#simulatorPanel").hidden = true;
    $("#simulatorFrame").removeAttribute("src");
    simulatorLoaded = false; simulatorRequested = false;
    $("#errorBox").hidden = true;
    refreshFiles();
    loadedExample = true;
    $("#exampleHint").textContent = `${example.name} loaded. Adjust settings, then click Generate toolpaths.`;
  } catch (error) {
    toast(error.message || "Could not load this example.");
    $("#exampleHint").textContent = error.message || "Could not load this example.";
  } finally {
    exampleLoading = false;
    $("#exampleBoard").disabled = false;
    $("#refreshExamplesButton").disabled = false;
    if (loadedExample) markGenerationDirty();
    else setGenerationStatus(generationRunning ? "Generating…" : lastOutput.length ? `${lastOutput.length} files ready` : hasBoardFiles() ? "Ready to generate" : "Waiting for board files", generationRunning ? "busy" : lastOutput.length ? "ready" : "idle");
  }
}
refreshFiles();
refreshExamples();

async function loadVisitorCount() {
  try {
    const response = await fetch("/api/visitors", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("Visitor count unavailable");
    const result = await response.json();
    if (!Number.isSafeInteger(result.visitors) || result.visitors < 1) throw new Error("Invalid visitor count");
    $("#visitorCount").textContent = result.visitors.toLocaleString();
    $("#visitorCounter").setAttribute("aria-label", `${result.visitors.toLocaleString()} visitors`);
    $("#visitorCounter").hidden = false;
  } catch {
    $("#visitorCounter").hidden = true;
  }
}
loadVisitorCount();
