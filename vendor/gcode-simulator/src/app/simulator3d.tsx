"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SAMPLE_GCODE } from "@/lib/sample-gcode";
import type { GCodeMove, GCodeSection, ToolConfig, Vec3 } from "@/lib/simulator";
import {
	applyMovesToHeightmap,
	parseGCode,
	simulateHeightmap,
	splitGCodeSections,
} from "@/lib/simulator";
import type { Heightmap } from "@/lib/simulator/types";
import type { SceneConfig } from "./scene";
import { SliderField } from "./slider-field";

const Scene = dynamic(() => import("./scene").then((m) => m.Scene), {
	ssr: false,
	loading: () => (
		<div className="flex h-full items-center justify-center text-sm text-zinc-500">
			Loading 3D renderer…
		</div>
	),
});

interface Config {
	stockWidth: number;
	stockDepth: number;
	stockHeight: number;
	cellSize: number;
}

const DEFAULTS: Config = {
	stockWidth: 100,
	stockDepth: 100,
	stockHeight: 20,
	cellSize: 0.125,
};

const DEFAULT_TOOL: ToolConfig = { diameter: 6, type: "flat" };
const MAX_GRID_SIDE = 1400;
const RAPID_FEED_MM_MIN = 3000;

function recommendedCellSize(width: number, depth: number, smallestTool: number) {
	const minimum = Math.max(0.02, Math.min(0.5, smallestTool / 3), Math.max(width, depth) / MAX_GRID_SIDE);
	return Math.ceil(minimum * 100) / 100;
}

function lengthOf(move: GCodeMove) {
	return Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z);
}

function formatTime(seconds: number) {
	const safe = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const remainder = safe % 60;
	return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

interface PlaybackMove {
	move: GCodeMove;
	toolDiameter: number;
	sectionLabel: string;
	side: ToolpathSide;
	startSeconds: number;
	endSeconds: number;
}

type ToolpathSide = "top" | "bottom" | "both";

function sideFromLabel(label: string, fallback: ToolpathSide): ToolpathSide {
	if (/back\s+copper/i.test(label)) return "bottom";
	if (/front\s+copper/i.test(label)) return "top";
	if (/drill|outline|profile|cut/i.test(label)) return "both";
	return fallback;
}

function toolFromLabel(label: string, fallback: ToolConfig = DEFAULT_TOOL): ToolConfig {
	const size = label.match(/(?:mill diameter|cutter diameter|drill size)\s+([0-9]*\.?[0-9]+)\s*mm/i);
	const diameter = size ? Number(size[1]) : fallback.diameter;
	return { diameter: Number.isFinite(diameter) && diameter > 0 ? diameter : fallback.diameter, type: "flat" };
}

interface SectionTool {
	id: string;
	section: GCodeSection;
	tool: ToolConfig;
	side: ToolpathSide;
}

interface Result {
	heightmap: Heightmap;
	bottomHeightmap: Heightmap | null;
	config: SceneConfig;
}

export function Simulator3D() {
	const embedded = typeof window !== "undefined" && window.parent !== window;
	const [gcode, setGcode] = useState(() => embedded ? "" : SAMPLE_GCODE);
	const [downloadExtension, setDownloadExtension] = useState<"ngc" | "nc">("ngc");
	const [gcodeName, setGcodeName] = useState(() => embedded ? "Waiting for toolpath" : "Sample toolpath");
	const [config, setConfig] = useState<Config>(DEFAULTS);
	const [sectionTools, setSectionTools] = useState<SectionTool[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<Result | null>(null);
	const [playbackHeightmap, setPlaybackHeightmap] = useState<Heightmap | null>(null);
	const [playbackBottomHeightmap, setPlaybackBottomHeightmap] = useState<Heightmap | null>(null);
	const [hasToolpath, setHasToolpath] = useState(!embedded);
	const [lightTheme, setLightTheme] = useState(false);
	const [previewFinished, setPreviewFinished] = useState(true);
	const [showTravelPaths, setShowTravelPaths] = useState(false);
	const [viewSide, setViewSide] = useState<"top" | "bottom">("top");
	const [autoRun, setAutoRun] = useState(true);
	const [playbackTime, setPlaybackTime] = useState(0);
	const [playbackSpeed, setPlaybackSpeed] = useState(25);
	const [isPlaying, setIsPlaying] = useState(false);
	const playbackTimeRef = useRef(0);
	const baseGcodeRef = useRef(embedded ? "" : SAMPLE_GCODE);
	const playbackDataRef = useRef<{ top: Float32Array; bottom: Float32Array } | null>(null);
	const processedPlaybackMoveRef = useRef(-1);
	const processedPlaybackProgressRef = useRef(0);
	const previousPlaybackTimeRef = useRef(0);
	const lastPlaybackStockUpdateRef = useRef(0);
	const playbackMinZRef = useRef({ top: 0, bottom: 0 });
	const playbackConfigKeyRef = useRef("");

	const resetPlayback = useCallback((finished = false) => {
		setPreviewFinished(finished);
		setIsPlaying(false);
		playbackTimeRef.current = 0;
		setPlaybackTime(0);
		setPlaybackHeightmap(null);
		setPlaybackBottomHeightmap(null);
		playbackDataRef.current = null;
		processedPlaybackMoveRef.current = -1;
		processedPlaybackProgressRef.current = 0;
		previousPlaybackTimeRef.current = 0;
		lastPlaybackStockUpdateRef.current = 0;
		playbackMinZRef.current = { top: 0, bottom: 0 };
		playbackConfigKeyRef.current = "";
	}, []);

	const playbackTimeline = useMemo(() => {
		const timeline: PlaybackMove[] = [];
		let position: Vec3 = { x: 0, y: 0, z: 0 };
		let elapsed = 0;
		for (const { section, tool, side } of sectionTools) {
			const moves = parseGCode(section.source, position);
			if (moves.length) position = moves[moves.length - 1].to;
			for (const move of moves) {
				const distance = lengthOf(move);
				const duration = move.type === "rapid"
					? distance / RAPID_FEED_MM_MIN * 60
					: move.durationSeconds ?? (distance / Math.max(1, move.feedRateMmMin ?? 100)) * 60;
				const safeDuration = Math.max(0.005, Number.isFinite(duration) ? duration : 0.005);
				timeline.push({ move, toolDiameter: tool.diameter, sectionLabel: section.label, side, startSeconds: elapsed, endSeconds: elapsed + safeDuration });
				elapsed += safeDuration;
			}
		}
		return { moves: timeline, duration: elapsed };
	}, [sectionTools]);
	const previewTime = previewFinished ? playbackTimeline.duration : playbackTime;
	const playbackMoveIndex = useMemo(() => {
		let low = 0, high = playbackTimeline.moves.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (playbackTimeline.moves[mid].endSeconds < previewTime) low = mid + 1;
			else high = mid;
		}
		return Math.min(low, playbackTimeline.moves.length - 1);
	}, [playbackTimeline, previewTime]);
	const activePlayback = playbackTimeline.moves[playbackMoveIndex];
	const playbackProgress = activePlayback
		? Math.max(0, Math.min(1, (previewTime - activePlayback.startSeconds) / (activePlayback.endSeconds - activePlayback.startSeconds)))
		: 0;
	const toolCoordinates = activePlayback ? {
		x: activePlayback.move.from.x + (activePlayback.move.to.x - activePlayback.move.from.x) * playbackProgress,
		y: activePlayback.move.from.y + (activePlayback.move.to.y - activePlayback.move.from.y) * playbackProgress,
		z: activePlayback.move.from.z + (activePlayback.move.to.z - activePlayback.move.from.z) * playbackProgress,
	} : null;
	const sceneMoves = useMemo(() => playbackTimeline.moves.map((entry) => ({ ...entry.move, side: entry.side })), [playbackTimeline]);
	const resolutionFloor = Math.ceil(Math.max(0.02, Math.max(config.stockWidth, config.stockDepth) / MAX_GRID_SIDE) * 100) / 100;
	const deepestCut = result ? Math.min(result.heightmap.minZ, result.bottomHeightmap?.minZ ?? 0) : 0;
	const reliefScale = deepestCut < 0
		? Math.max(1, (config.stockHeight * 0.42) / Math.abs(deepestCut))
		: 1;

	useEffect(() => {
		playbackTimeRef.current = playbackTime;
	}, [playbackTime]);

	useEffect(() => {
		if (previewFinished || !activePlayback) return;
		const cols = Math.ceil(config.stockWidth / config.cellSize);
		const rows = Math.ceil(config.stockDepth / config.cellSize);
		const configKey = `${config.stockWidth}:${config.stockDepth}:${config.stockHeight}:${config.cellSize}`;
		const shouldReset = !playbackDataRef.current || playbackTime < previousPlaybackTimeRef.current ||
			playbackMoveIndex < processedPlaybackMoveRef.current ||
			playbackDataRef.current.top.length !== cols * rows || playbackConfigKeyRef.current !== configKey;
		if (shouldReset) {
			playbackDataRef.current = { top: new Float32Array(cols * rows), bottom: new Float32Array(cols * rows) };
			processedPlaybackMoveRef.current = -1;
			processedPlaybackProgressRef.current = 0;
			playbackMinZRef.current = { top: 0, bottom: 0 };
			playbackConfigKeyRef.current = configKey;
		}
		const now = performance.now();
		const data = playbackDataRef.current;
		if (!data) return;
		const applyEntry = (index: number, fromProgress: number, toProgress: number) => {
			if (toProgress <= fromProgress) return;
			const entry = playbackTimeline.moves[index];
			if (!entry) return;
			const move = entry.move;
			const at = (progress: number) => ({
				x: move.from.x + (move.to.x - move.from.x) * progress,
				y: move.from.y + (move.to.y - move.from.y) * progress,
				z: move.from.z + (move.to.z - move.from.z) * progress,
			});
			const partial = {
				...move,
				from: at(fromProgress),
				to: at(toProgress),
			};
			const simulationConfig = {
				stock: { width: config.stockWidth, depth: config.stockDepth, height: config.stockHeight },
				tool: { diameter: entry.toolDiameter, type: "flat" as const },
				cellSize: config.cellSize,
			};
			if (entry.side !== "bottom") {
				applyMovesToHeightmap([partial], simulationConfig, data.top);
				if (partial.type !== "rapid") playbackMinZRef.current.top = Math.min(playbackMinZRef.current.top, partial.from.z, partial.to.z);
			}
			if (entry.side !== "top") {
				applyMovesToHeightmap([partial], simulationConfig, data.bottom);
				if (partial.type !== "rapid") playbackMinZRef.current.bottom = Math.min(playbackMinZRef.current.bottom, partial.from.z, partial.to.z);
			}
		};
		let nextIndex = processedPlaybackMoveRef.current;
		let nextProgress = processedPlaybackProgressRef.current;
		if (playbackMoveIndex > nextIndex) {
			if (nextIndex >= 0) applyEntry(nextIndex, nextProgress, 1);
			for (let index = nextIndex + 1; index < playbackMoveIndex; index++) applyEntry(index, 0, 1);
			nextIndex = playbackMoveIndex;
			nextProgress = 0;
		}
		if (playbackMoveIndex === nextIndex) applyEntry(playbackMoveIndex, nextProgress, playbackProgress);
		nextIndex = playbackMoveIndex;
		nextProgress = playbackProgress;
		processedPlaybackMoveRef.current = nextIndex;
		processedPlaybackProgressRef.current = nextProgress;
		previousPlaybackTimeRef.current = playbackTime;
		if (isPlaying && !shouldReset && now - lastPlaybackStockUpdateRef.current < 33) return;
		lastPlaybackStockUpdateRef.current = now;
		setPlaybackHeightmap({ cols, rows, cellSize: config.cellSize, data: data.top.slice(), minZ: playbackMinZRef.current.top, maxZ: 0 });
		setPlaybackBottomHeightmap({ cols, rows, cellSize: config.cellSize, data: data.bottom.slice(), minZ: playbackMinZRef.current.bottom, maxZ: 0 });
	}, [previewFinished, playbackTime, playbackMoveIndex, playbackProgress, playbackTimeline, activePlayback, config, isPlaying]);

	useEffect(() => {
		resetPlayback(true);
	}, [gcode, resetPlayback]);

	useEffect(() => {
		if (!isPlaying || playbackTimeline.duration <= 0) return;
		let frame = 0;
		let previous = 0;
		const tick = (now: number) => {
			if (!previous) previous = now;
			const next = playbackTimeRef.current + ((now - previous) / 1000) * playbackSpeed;
			previous = now;
			if (next >= playbackTimeline.duration) {
				playbackTimeRef.current = playbackTimeline.duration;
				setPlaybackTime(playbackTimeline.duration);
				setIsPlaying(false);
				return;
			}
			playbackTimeRef.current = next;
			setPlaybackTime(next);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [isPlaying, playbackSpeed, playbackTimeline.duration]);

	// Carry the actual cutter diameter and board side through tool-change preambles.
	useEffect(() => {
		const sections = splitGCodeSections(gcode);
		let activeSide: ToolpathSide = "top";
		const firstTool = sections.find((section) => /(?:mill diameter|cutter diameter|drill size)\s+[0-9]/i.test(section.label));
		let activeTool = toolFromLabel(firstTool?.label ?? "");
		setSectionTools((prev) => sections.map((section, i) => {
			activeSide = sideFromLabel(section.label, activeSide);
			activeTool = toolFromLabel(section.label, activeTool);
			return {
				id: prev[i]?.section.label === section.label ? prev[i].id : crypto.randomUUID(),
				section,
				tool: activeTool,
				side: activeSide,
			};
		}));
	}, [gcode]);

	const run = useCallback(() => {
		setError(null);
		try {
			const cols = Math.ceil(config.stockWidth / config.cellSize);
			const rows = Math.ceil(config.stockDepth / config.cellSize);
			const topData = new Float32Array(cols * rows);
			const bottomData = new Float32Array(cols * rows);
			let topHeightmap: Heightmap | null = null;
			let bottomHeightmap: Heightmap | null = null;
			let position: Vec3 = { x: 0, y: 0, z: 0 };

			for (const { section, tool, side } of sectionTools) {
				const moves = parseGCode(section.source, position);
				if (moves.length) position = moves[moves.length - 1].to;
				const simulationConfig = {
					stock: { width: config.stockWidth, depth: config.stockDepth, height: config.stockHeight },
					tool,
					cellSize: config.cellSize,
				};
				if (side !== "bottom") topHeightmap = simulateHeightmap(moves, simulationConfig, undefined, topData);
				if (side !== "top") bottomHeightmap = simulateHeightmap(moves, simulationConfig, undefined, bottomData);
			}

			if (!topHeightmap) topHeightmap = simulateHeightmap([], { stock: { width: config.stockWidth, depth: config.stockDepth, height: config.stockHeight }, tool: sectionTools[0]?.tool ?? DEFAULT_TOOL, cellSize: config.cellSize }, undefined, topData);

			setResult({
				heightmap: topHeightmap,
				bottomHeightmap,
				config: {
					stockWidth: config.stockWidth,
					stockDepth: config.stockDepth,
					stockHeight: config.stockHeight,
				},
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Unknown error");
		}
	}, [config, sectionTools]);

	useEffect(() => {
		if (!autoRun) return;
		const expected = splitGCodeSections(gcode);
		if (
			expected.length !== sectionTools.length ||
			expected.some((section, i) => sectionTools[i]?.section.source !== section.source)
		) {
			return;
		}
		run();
		setAutoRun(false);
	}, [autoRun, gcode, run, sectionTools]);

	useEffect(() => {
		function receiveToolpath(event: MessageEvent) {
			if (event.origin !== window.location.origin || event.source !== window.parent) return;
			const payload = event.data;
			if (payload?.type === "pcb2gcode:theme") {
				const isLight = payload.theme === "light";
				setLightTheme(isLight);
				document.documentElement.classList.toggle("pcb-theme-light", isLight);
				return;
			}
			if (payload?.type === "pcb2gcode:download-format" || payload?.type === "pcb2gcode:load") {
				if (payload.downloadExtension === "nc" || payload.downloadExtension === "ngc") setDownloadExtension(payload.downloadExtension);
			}
			if (payload?.type === "pcb2gcode:download-format") return;
			if (payload?.type !== "pcb2gcode:load" || typeof payload.gcode !== "string") return;
			if (payload.gcode.length > 20 * 1024 * 1024) {
				setError("This toolpath exceeds the simulator's 20 MB input limit.");
				return;
			}
			const dimensions = [payload.stockWidth, payload.stockDepth, payload.stockHeight];
			if (dimensions.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
				setError("Invalid stock dimensions supplied for this toolpath.");
				return;
			}
			if (dimensions.some((value) => value > 1000)) {
				setError("Stock dimensions over 1000 mm exceed the interactive preview limit.");
				return;
			}
			const sections = splitGCodeSections(payload.gcode);
			const smallestTool = Math.min(...sections.map((section) => toolFromLabel(section.label).diameter));
			setError(null);
			setResult(null);
			resetPlayback(true);
			setViewSide(sections.some((section) => sideFromLabel(section.label, "top") === "bottom") &&
				!sections.some((section) => /front\s+copper/i.test(section.label)) ? "bottom" : "top");
			setGcodeName(typeof payload.name === "string" ? payload.name.slice(0, 120) : "PCB toolpath");
			baseGcodeRef.current = payload.gcode;
			setConfig((previous) => ({
				...previous,
				stockWidth: payload.stockWidth,
				stockDepth: payload.stockDepth,
				stockHeight: payload.stockHeight,
				cellSize: recommendedCellSize(payload.stockWidth, payload.stockDepth, smallestTool),
			}));
			setGcode(payload.gcode);
			setHasToolpath(true);
			setAutoRun(true);
		}
		window.addEventListener("message", receiveToolpath);
		window.parent.postMessage({ type: "pcb2gcode:ready" }, window.location.origin);
		return () => window.removeEventListener("message", receiveToolpath);
	}, [resetPlayback]);

	useEffect(() => {
		if (!embedded) return;
		function scrollWorkspace(event: WheelEvent) {
			// Reserve modified wheel gestures for zooming the 3D view.
			if (event.ctrlKey || event.metaKey || !event.deltaY) return;
			let target = event.target instanceof HTMLElement ? event.target : null;
			while (target && target !== document.body) {
				const overflow = getComputedStyle(target).overflowY;
				const canScroll = /auto|scroll/.test(overflow) && target.scrollHeight > target.clientHeight;
				if (canScroll && (event.deltaY < 0 ? target.scrollTop > 0 : target.scrollTop + target.clientHeight < target.scrollHeight - 1)) return;
				target = target.parentElement;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			const deltaY = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
			window.parent.postMessage({ type: "pcb2gcode:scroll", deltaY }, window.location.origin);
		}
		document.addEventListener("wheel", scrollWorkspace, { capture: true, passive: false });
		return () => document.removeEventListener("wheel", scrollWorkspace, { capture: true });
	}, [embedded]);

	function setConfigKey<K extends keyof Config>(key: K, value: Config[K]) {
		setConfig((prev) => {
			const next = { ...prev, [key]: value };
			if (key === "stockWidth" || key === "stockDepth") {
				next.cellSize = Math.max(next.cellSize, Math.ceil(Math.max(next.stockWidth, next.stockDepth) / MAX_GRID_SIDE * 100) / 100);
			}
			return next;
		});
	}

	const emptyHeightmap = useMemo<Heightmap>(() => {
		const cols = Math.ceil(config.stockWidth / config.cellSize);
		const rows = Math.ceil(config.stockDepth / config.cellSize);
		return { cols, rows, cellSize: config.cellSize, data: new Float32Array(cols * rows), minZ: 0, maxZ: 0 };
	}, [config.stockWidth, config.stockDepth, config.cellSize]);
	const visibleHeightmap = previewFinished ? result?.heightmap ?? emptyHeightmap : playbackHeightmap ?? emptyHeightmap;
	const hasBottomSurface = sectionTools.some(({ side }) => side !== "top");
	const visibleBottomHeightmap = hasBottomSurface ? (previewFinished ? result?.bottomHeightmap ?? emptyHeightmap : playbackBottomHeightmap ?? emptyHeightmap) : null;
	if (embedded && !hasToolpath) return <div className="flex h-screen items-center justify-center bg-background text-sm text-zinc-500">Waiting for generated toolpath…</div>;

	return (
		<div className="flex h-screen flex-col lg:flex-row">
			<aside className="order-2 flex max-h-[45vh] shrink-0 flex-col overflow-y-auto border-t border-zinc-800 bg-background p-4 lg:order-1 lg:h-full lg:max-h-none lg:w-[280px] lg:border-r lg:border-t-0">
				<div className="mb-3 flex items-center justify-between gap-3">
					<strong className="min-w-0 truncate text-xs text-zinc-300">{gcodeName}</strong>
					<select aria-label="Playback speed" value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value))} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
						{[1, 5, 10, 25, 50, 100, 250].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
					</select>
				</div>
				{hasBottomSurface && <div className="mb-3 flex gap-2">
					<Button type="button" variant={viewSide === "top" ? "secondary" : "outline"} className="flex-1" onClick={() => setViewSide("top")}>Top face</Button>
					<Button type="button" variant={viewSide === "bottom" ? "secondary" : "outline"} className="flex-1" onClick={() => setViewSide("bottom")}>Bottom face</Button>
				</div>}
				<div className="flex gap-2">
					<Button type="button" variant="secondary" className="flex-1" disabled={!playbackTimeline.moves.length} onClick={() => {
						if (previewFinished || playbackTimeRef.current >= playbackTimeline.duration) resetPlayback();
						setIsPlaying((playing) => !playing);
					}}>{isPlaying ? "Pause" : "Play"}</Button>
					<Button type="button" variant="outline" disabled={!playbackTimeline.moves.length} onClick={() => {
						resetPlayback();
					}}>Restart</Button>
				</div>
				<input aria-label="G-code playback position" type="range" min="0" max={Math.max(playbackTimeline.duration, 0.01)} step={Math.max(playbackTimeline.duration / 2000, 0.005)} value={Math.min(previewTime, playbackTimeline.duration)} onChange={(event) => {
					const value = Number(event.target.value); setPreviewFinished(false); playbackTimeRef.current = value; setPlaybackTime(value); setIsPlaying(false);
				}} className="my-3 w-full accent-amber-400" disabled={!playbackTimeline.moves.length} />
				<div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
					<span>{formatTime(previewTime)} / {formatTime(playbackTimeline.duration)}</span>
					<span>{activePlayback ? `Move ${playbackMoveIndex + 1} / ${playbackTimeline.moves.length}` : "No moves"}</span>
				</div>
				{!previewFinished && activePlayback && <p className="mt-2 truncate text-[10px] text-zinc-500">{activePlayback.sectionLabel} · {activePlayback.side} · {activePlayback.move.type === "rapid" ? `rapid ${RAPID_FEED_MM_MIN} mm/min` : `${(activePlayback.move.feedRateMmMin ?? 100).toFixed(0)} mm/min`}</p>}
				{previewFinished ? <p aria-label="Tool motion" className="mt-2 text-[11px] text-zinc-300">Finished preview</p> : activePlayback && toolCoordinates && <p aria-label="Tool motion" className="mt-2 text-[11px] text-zinc-300">
					{activePlayback.move.type === "rapid" ? "Rapid travel" : toolCoordinates.z < 0 ? "Cutting" : "Feed move"}
					{toolCoordinates.z >= 0 ? ` · clearance ${toolCoordinates.z.toFixed(3)} mm` : ` · depth ${Math.abs(toolCoordinates.z).toFixed(3)} mm`}
				</p>}
				{!previewFinished && toolCoordinates && <p aria-label="Tool coordinates" className="mt-2 font-mono text-[11px] text-zinc-300">
					X {toolCoordinates.x.toFixed(3)} · Y {toolCoordinates.y.toFixed(3)} · Z {toolCoordinates.z.toFixed(3)} mm
				</p>}
				{deepestCut < 0 && <p className="mt-2 text-[10px] text-amber-400">Shallow cuts enlarged {reliefScale.toFixed(1)}× in preview</p>}
				{error && <p className="mt-3 rounded border border-red-800 bg-red-950 px-3 py-2 text-xs text-red-400">{error}</p>}
				<section aria-labelledby="preview-settings-title" className="mt-4 border-t border-zinc-800 pt-3">
					<h2 id="preview-settings-title" className="text-xs font-medium text-zinc-400">G-code and preview settings</h2>
					<div className="mt-3 grid gap-3">
						<div className="flex items-center justify-between gap-3">
							<span className="truncate text-[10px] text-zinc-500">Cell size {config.cellSize} mm</span>
							<span className="shrink-0 text-[10px] text-zinc-600">{Math.ceil(config.stockWidth / config.cellSize)} × {Math.ceil(config.stockDepth / config.cellSize)}</span>
						</div>
						<label className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox" checked={showTravelPaths} onChange={(event) => setShowTravelPaths(event.target.checked)} />Show rapid travel paths</label>
						<SliderField label="Preview resolution" value={config.cellSize} min={resolutionFloor} max={5} step={0.01} onChange={(value) => setConfigKey("cellSize", value)} />
						<div className="flex items-center justify-between gap-3">
							<span className="truncate text-xs text-zinc-300">Edit G-code</span>
							<div className="flex gap-3 text-xs text-zinc-500">
								<label className="cursor-pointer hover:text-zinc-300">Open<input type="file" accept=".nc,.gcode,.ngc,.tap,.txt" className="sr-only" onChange={(event) => {
									const file = event.target.files?.[0];
									if (file) file.text().then((text) => { baseGcodeRef.current = text; setGcode(text); });
									event.target.value = "";
								}} /></label>
								<button type="button" onClick={() => setGcode(baseGcodeRef.current || SAMPLE_GCODE)} className="hover:text-zinc-300">Reset</button>
							</div>
						</div>
						<Textarea value={gcode} onChange={(event) => setGcode(event.target.value)} className="max-h-56 min-h-36 resize-y bg-zinc-900 font-mono text-[10px] text-zinc-300" spellCheck={false} />
						<Button type="button" onClick={() => { resetPlayback(true); run(); }} className="rebuild-preview-button">Rebuild preview</Button>
						<Button type="button" variant="outline" disabled={!gcode.trim()} onClick={() => {
							const blob = new Blob([gcode], { type: "text/plain;charset=utf-8" });
							const url = URL.createObjectURL(blob);
							const link = document.createElement("a");
							const safeName = gcodeName.replace(/[^a-z0-9_.-]+/gi, "-");
							link.href = url;
							link.download = safeName.replace(/\.(?:ngc|gcode|nc|tap|txt)$/i, "") + `-modified.${downloadExtension}`;
							link.click();
							window.setTimeout(() => URL.revokeObjectURL(url), 1000);
						}}>Download modified G-code</Button>
					</div>
				</section>
			</aside>
			<div className="relative order-1 min-h-[55vh] flex-1 lg:order-2 lg:min-h-0">
				<div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded bg-background/80 px-2 py-1 text-[10px] text-zinc-400">
					Drag to rotate · {embedded ? "Ctrl + wheel to zoom · Scroll up for setup" : "Wheel to zoom"}
				</div>
				<Scene
					heightmap={visibleHeightmap}
						bottomHeightmap={visibleBottomHeightmap}
						reliefDepth={deepestCut}
					backgroundColor={lightTheme ? "#f2f4f0" : "#101211"}
						viewSide={viewSide}
					moves={sceneMoves}
					showTravelPaths={showTravelPaths}
						playback={!previewFinished && activePlayback ? { move: activePlayback.move, progress: playbackProgress, diameter: activePlayback.toolDiameter, side: activePlayback.side === "bottom" ? "bottom" : "top" } : null}
					config={
						result?.config ?? {
							stockWidth: config.stockWidth,
							stockDepth: config.stockDepth,
							stockHeight: config.stockHeight,
						}
					}
				/>
			</div>
		</div>
	);
}
