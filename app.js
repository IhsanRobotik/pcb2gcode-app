const roles = ["front", "back", "outline", "drill", "npth", "job"];
const engineRoles = new Set(["front", "back", "outline", "drill", "npth"]);
const selectedFiles = new Map();
const $ = (selector) => document.querySelector(selector);
const fields = new Proxy({}, { get: (_, name) => document.querySelector(`[name="${String(name)}"]`) });
let units = "metric";
let lastOutput = [];
let generatedUrls = [];
let boardMetadata = null;
let pendingSimulatorPayload = null;
let simulatorLoaded = false;
let simulatorRequested = false;

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
  $("#generateButton").disabled = count === 0;
}
function formatBytes(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }

document.querySelectorAll(".file-slot input").forEach((input) => {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) {
      const role = input.closest(".file-slot").dataset.role;
      const total = [...selectedFiles.entries()].reduce((size, [key, item]) => size + (key === role ? 0 : item.size), file.size);
      if (total > 100 * 1024 * 1024) { toast("Board files must total 100 MB or less"); input.value = ""; return; }
      selectedFiles.set(role, file);
      if (role === "job") readJobFile(file);
    }
    input.value = "";
    refreshFiles();
  });
});
document.querySelectorAll(".file-slot").forEach((slot) => {
  slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("has-file"); });
  slot.addEventListener("dragleave", () => { if (!selectedFiles.has(slot.dataset.role)) slot.classList.remove("has-file"); });
  slot.addEventListener("drop", (e) => {
    e.preventDefault(); const file = e.dataTransfer.files[0];
    if (file) {
      const role = slot.dataset.role;
      const total = [...selectedFiles.entries()].reduce((size, [key, item]) => size + (key === role ? 0 : item.size), file.size);
      if (total > 100 * 1024 * 1024) { toast("Board files must total 100 MB or less"); return; }
      selectedFiles.set(role, file); refreshFiles();
      if (role === "job") readJobFile(file);
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

function combineToolpathFiles(outputs) {
  return [...outputs]
    .sort((a, b) => toolpathRole(a.name).order - toolpathRole(b.name).order || a.name.localeCompare(b.name))
    .map((output) => `M0 (MSG, Change tool for ${toolpathRole(output.name).label})\n${output.content.trim()}`)
    .join("\n\n");
}

function sendToSimulator(payload, scroll = true) {
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
  if (event.origin !== location.origin || event.source !== $("#simulatorFrame").contentWindow || event.data?.type !== "pcb2gcode:ready") return;
  simulatorLoaded = true;
  $("#simulatorFrame").contentWindow.postMessage({ type: "pcb2gcode:theme", theme: document.body.classList.contains("light") ? "light" : "dark" }, location.origin);
  if (pendingSimulatorPayload) $("#simulatorFrame").contentWindow.postMessage(pendingSimulatorPayload, location.origin);
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
    const filename = document.createElement("strong"); filename.textContent = output.name;
    const details = document.createElement("small"); details.textContent = `${moves.toLocaleString()} motion blocks · ${formatBytes(blob.size)}`;
    description.append(kind, filename, details); main.append(description);
    const actions = document.createElement("div"); actions.className = "output-actions";
    const simulate = document.createElement("button"); simulate.type = "button"; simulate.className = "simulate-button"; simulate.textContent = "View 3D";
    simulate.addEventListener("click", () => {
      const prepared = simulatorFilePreview(output);
      sendToSimulator({
        type: "pcb2gcode:load", name: output.name, gcode: prepared.gcode,
        stockWidth: prepared.stockWidth, stockDepth: prepared.stockDepth,
        stockHeight: (Number(fields.boardThickness.value) || 1.6) * (units === "imperial" ? 25.4 : 1),
      }, true);
    });
    const link = document.createElement("a"); link.className = "download-button"; link.href = URL.createObjectURL(blob); generatedUrls.push(link.href);
    link.download = output.name; link.textContent = "Download";
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

$("#generateButton").addEventListener("click", async () => {
  const button = $("#generateButton"), error = $("#errorBox"); error.hidden = true;
  try {
    const config = collectConfig();
    if (selectedFiles.size === 0) throw new Error("Choose at least one board file first.");
    const data = new FormData(); data.append("config", JSON.stringify(config));
    for (const [role, file] of selectedFiles) if (engineRoles.has(role)) data.append(role, file, file.name);
    button.disabled = true; button.querySelector("span").textContent = "Generating…";
    const response = await fetch("/api/generate", { method: "POST", body: data });
    const result = await response.json();
    if (!response.ok) throw new Error([result.error, result.details].filter(Boolean).join("\n"));
    displayOutputs(result); toast(`${result.files.length} output file${result.files.length === 1 ? "" : "s"} generated`);
  } catch (err) {
    error.textContent = err.message || "The job could not be generated."; error.hidden = false;
    error.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } finally { button.disabled = selectedFiles.size === 0; button.querySelector("span").textContent = "Generate toolpaths"; }
});

$("#themeButton").addEventListener("click", () => {
  document.body.classList.toggle("light"); localStorage.setItem("toolpath-theme", document.body.classList.contains("light") ? "light" : "dark");
  if (simulatorLoaded) $("#simulatorFrame").contentWindow.postMessage({ type: "pcb2gcode:theme", theme: document.body.classList.contains("light") ? "light" : "dark" }, location.origin);
});
if (localStorage.getItem("toolpath-theme") === "light") document.body.classList.add("light");

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
}));

async function loadExampleGerber() {
  try {
    const response = await fetch("/api/example/front-gerber");
    if (!response.ok) throw new Error("Example front copper Gerber could not be loaded.");
    const file = new File([await response.blob()], "bike lcd-F_Cu.gbr", { type: "application/octet-stream" });
    selectedFiles.set("front", file);
    refreshFiles();
    $("#generateButton").click();
  } catch (error) {
    toast(error.message || "Example front copper Gerber could not be loaded.");
  }
}
refreshFiles();
loadExampleGerber();
