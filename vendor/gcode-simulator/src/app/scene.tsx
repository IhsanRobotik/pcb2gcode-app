"use client";

import { GizmoHelper, GizmoViewport, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { displayZ } from "@/lib/simulator/display";
import type { GCodeMove, Heightmap } from "@/lib/simulator/types";

// ── GLSL shaders ─────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  // Heightmap: R channel = surface Z in mm (≤ 0).
  uniform sampler2D uHeightmap;
  uniform float uZScale;
  uniform float uDirection;
  uniform float uStockHeight;
  uniform float uSurfaceOffset;

  // Passed to the fragment shader for depth colouring and normal estimation.
  varying vec2  vUv;
  varying float vZ;

  void main() {
    vUv = uv;

    // Sample Z from the heightmap and displace this vertex along Z.
    // The PlaneGeometry has one vertex per heightmap cell, so each sample
    // lands exactly on a texel centre — no interpolation artefacts.
    float z = texture2D(uHeightmap, uv).r;
    vZ = z;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, position.y, uSurfaceOffset + max(-uStockHeight, z * uZScale) * uDirection, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uHeightmap;
  // One texel in UV space: vec2(1.0/cols, 1.0/rows).
  uniform vec2  uTexelSize;
  // Physical size of one texel in mm (= cellSize).
  uniform float uCellSize;
  uniform float uZScale;
  uniform float uDirection;
  uniform float uStockHeight;

  varying vec2  vUv;
  varying float vZ;

  void main() {
    // ── Surface normal via 5×5 Gaussian-weighted Sobel ────────────────────
    // Kernel = [1 4 6 4 1]ᵀ ⊗ [-1 -2 0 2 1]   (and its transpose for dZ/dy).
    // Why 5×5 and not 3×3:
    //   For a flat-endmill rim, the heightmap drops from 0 (uncut) to
    //   -depth (cut) across a single cell — a vertical wall the grid can't
    //   represent. Along a *curved* rim, the "first cell inside" line
    //   zig-zags against the cell grid; a 3×3 Sobel still resolves that
    //   single-cell flip and shades it as periodic bands. The extra
    //   Gaussian rows smooth those flips into a continuous wall gradient.
    //   See docs/heightmap-rim-artifacts.md for the long-form explanation
    //   and a future upgrade path (dexel representation) that would fix
    //   the data side too.
    //
    // Naming: z{col}{row}, indices 0..4 mapping to offsets -2..+2 cells.
    float tx = uTexelSize.x;
    float ty = uTexelSize.y;
    float z00 = texture2D(uHeightmap, vUv + vec2(-2.0*tx, -2.0*ty)).r;
    float z10 = texture2D(uHeightmap, vUv + vec2(-1.0*tx, -2.0*ty)).r;
    float z20 = texture2D(uHeightmap, vUv + vec2( 0.0,    -2.0*ty)).r;
    float z30 = texture2D(uHeightmap, vUv + vec2( 1.0*tx, -2.0*ty)).r;
    float z40 = texture2D(uHeightmap, vUv + vec2( 2.0*tx, -2.0*ty)).r;
    float z01 = texture2D(uHeightmap, vUv + vec2(-2.0*tx, -1.0*ty)).r;
    float z11 = texture2D(uHeightmap, vUv + vec2(-1.0*tx, -1.0*ty)).r;
    float z21 = texture2D(uHeightmap, vUv + vec2( 0.0,    -1.0*ty)).r;
    float z31 = texture2D(uHeightmap, vUv + vec2( 1.0*tx, -1.0*ty)).r;
    float z41 = texture2D(uHeightmap, vUv + vec2( 2.0*tx, -1.0*ty)).r;
    float z02 = texture2D(uHeightmap, vUv + vec2(-2.0*tx,  0.0   )).r;
    float z12 = texture2D(uHeightmap, vUv + vec2(-1.0*tx,  0.0   )).r;
    float z22 = texture2D(uHeightmap, vUv                         ).r;
    float z32 = texture2D(uHeightmap, vUv + vec2( 1.0*tx,  0.0   )).r;
    float z42 = texture2D(uHeightmap, vUv + vec2( 2.0*tx,  0.0   )).r;
    float z03 = texture2D(uHeightmap, vUv + vec2(-2.0*tx,  1.0*ty)).r;
    float z13 = texture2D(uHeightmap, vUv + vec2(-1.0*tx,  1.0*ty)).r;
    float z23 = texture2D(uHeightmap, vUv + vec2( 0.0,     1.0*ty)).r;
    float z33 = texture2D(uHeightmap, vUv + vec2( 1.0*tx,  1.0*ty)).r;
    float z43 = texture2D(uHeightmap, vUv + vec2( 2.0*tx,  1.0*ty)).r;
    float z04 = texture2D(uHeightmap, vUv + vec2(-2.0*tx,  2.0*ty)).r;
    float z14 = texture2D(uHeightmap, vUv + vec2(-1.0*tx,  2.0*ty)).r;
    float z24 = texture2D(uHeightmap, vUv + vec2( 0.0,     2.0*ty)).r;
    float z34 = texture2D(uHeightmap, vUv + vec2( 1.0*tx,  2.0*ty)).r;
    float z44 = texture2D(uHeightmap, vUv + vec2( 2.0*tx,  2.0*ty)).r;

    // Normalisation: applying [-1,-2,0,2,1] to a unit ramp z=x gives 8;
    // the row-weight vector [1,4,6,4,1] sums to 16 → divide by 128 to get
    // slope in (mm Z) per (cell). Divide again by cellSize for mm/mm.
    float dzdx = (
      -1.0*z00 - 2.0*z10            + 2.0*z30 + 1.0*z40
      -4.0*z01 - 8.0*z11            + 8.0*z31 + 4.0*z41
      -6.0*z02 -12.0*z12            +12.0*z32 + 6.0*z42
      -4.0*z03 - 8.0*z13            + 8.0*z33 + 4.0*z43
      -1.0*z04 - 2.0*z14            + 2.0*z34 + 1.0*z44
    ) / (128.0 * uCellSize / uZScale);

    float dzdy = (
      -1.0*z00 - 4.0*z10 - 6.0*z20 - 4.0*z30 - 1.0*z40
      -2.0*z01 - 8.0*z11 -12.0*z21 - 8.0*z31 - 2.0*z41
      // middle row (j=0) has zero weight
      +2.0*z03 + 8.0*z13 +12.0*z23 + 8.0*z33 + 2.0*z43
      +1.0*z04 + 4.0*z14 + 6.0*z24 + 4.0*z34 + 1.0*z44
    ) / (128.0 * uCellSize / uZScale);

    // For a heightmap z = f(x,y), the surface normal is (-dzdx, -dzdy, 1).
    vec3 normal = normalize(vec3(-dzdx, -dzdy, 1.0)) * uDirection;

    // ── Ambient + diffuse lighting ────────────────────────────────────────
    // Color from the actual cut depth, independently of exaggerated relief.
    float cutDepth = max(-z22, 0.0);
    if (cutDepth >= uStockHeight - 0.0001) discard;
    float cutMix = smoothstep(0.00001, 0.001, cutDepth);
    vec3  baseColor = mix(vec3(0.12, 0.27, 0.15), vec3(0.82, 0.46, 0.23), cutMix);
    vec3  lightDir  = normalize(vec3(1.0, 1.0, 2.0));
    float diffuse   = abs(dot(normal, lightDir));
    float light     = 0.4 + 0.6 * diffuse;

    gl_FragColor = vec4(baseColor * light, 1.0);
  }
`;

// ── Components ────────────────────────────────────────────────────────────────

export interface SceneConfig {
	stockWidth: number;
	stockDepth: number;
	stockHeight: number;
}

function HeightmapMesh({
	heightmap,
	config,
	zScale,
	side,
}: {
	heightmap: Heightmap;
	config: SceneConfig;
	zScale: number;
	side: "top" | "bottom";
}) {
	const { stockWidth, stockDepth } = config;

	// Upload the heightmap once as a single-channel float texture.
	// The vertex shader displaces each vertex by sampling this texture —
	// zero CPU work per frame after upload.
	const texture = useMemo(() => {
		const tex = new THREE.DataTexture(
			heightmap.data,
			heightmap.cols,
			heightmap.rows,
			THREE.RedFormat,
			THREE.FloatType,
		);
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.needsUpdate = true;
		return tex;
	}, [heightmap]);

	const material = useMemo(
		() =>
			new THREE.ShaderMaterial({
				vertexShader,
				fragmentShader,
				uniforms: {
					uHeightmap: { value: texture },
					uZScale: { value: zScale },
						uDirection: { value: side === "top" ? 1 : -1 },
					uStockHeight: { value: config.stockHeight },
						uSurfaceOffset: { value: side === "top" ? 0 : -config.stockHeight },
					uTexelSize: {
						value: new THREE.Vector2(1 / heightmap.cols, 1 / heightmap.rows),
					},
					uCellSize: { value: heightmap.cellSize },
				},
				side: THREE.DoubleSide,
			}),
		[texture, heightmap, zScale, side, config.stockHeight],
	);

	// One vertex per heightmap cell — each UV lands exactly on a texel centre.
	return (
		<mesh material={material}>
			<planeGeometry
				args={[stockWidth, stockDepth, heightmap.cols - 1, heightmap.rows - 1]}
			/>
		</mesh>
	);
}

type SceneMove = GCodeMove & { side: "top" | "bottom" | "both" };

function toolpathGeometry(moves: SceneMove[], width: number, depth: number, height: number, rapid: boolean, side: "top" | "bottom", zScale: number) {
	const positions: number[] = [];
	for (const move of moves) {
		if ((move.type === "rapid") !== rapid) continue;
		if (move.side !== side && move.side !== "both") continue;
		const zAt = (z: number) => side === "top" ? displayZ(z, zScale) : -height - displayZ(z, zScale);
		positions.push(move.from.x - width / 2, move.from.y - depth / 2, zAt(move.from.z));
		positions.push(move.to.x - width / 2, move.to.y - depth / 2, zAt(move.to.z));
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
	geometry.computeBoundingSphere();
	return geometry;
}

function ToolpathOverlay({
	moves,
	width,
	depth,
	height,
	playback,
	zScale,
	viewSide,
	showTravelPaths,
}: {
		moves: SceneMove[];
	width: number;
	depth: number;
	height: number;
	playback: { move: GCodeMove; progress: number; diameter: number; side: "top" | "bottom" } | null;
	zScale: number;
	viewSide: "top" | "bottom";
	showTravelPaths: boolean;
}) {
	const rapidTopGeometry = useMemo(() => toolpathGeometry(moves, width, depth, height, true, "top", zScale), [moves, width, depth, height, zScale]);
	const rapidBottomGeometry = useMemo(() => toolpathGeometry(moves, width, depth, height, true, "bottom", zScale), [moves, width, depth, height, zScale]);
	const activeGeometry = useMemo(() => {
		const geometry = new THREE.BufferGeometry();
		if (playback) {
			const { move, progress } = playback;
			const x = move.from.x + (move.to.x - move.from.x) * progress - width / 2;
			const y = move.from.y + (move.to.y - move.from.y) * progress - depth / 2;
			const depthAt = (z: number) => playback.side === "top" ? displayZ(z, zScale) : -height - displayZ(z, zScale);
			geometry.setAttribute("position", new THREE.Float32BufferAttribute([
				move.from.x - width / 2, move.from.y - depth / 2, depthAt(move.from.z),
				x, y, depthAt(move.from.z + (move.to.z - move.from.z) * progress),
			], 3));
		}
		geometry.computeBoundingSphere();
		return geometry;
	}, [playback, width, depth, height, zScale]);

	const toolPosition = playback ? [
		playback.move.from.x + (playback.move.to.x - playback.move.from.x) * playback.progress - width / 2,
		playback.move.from.y + (playback.move.to.y - playback.move.from.y) * playback.progress - depth / 2,
		playback.side === "top"
			? displayZ(playback.move.from.z + (playback.move.to.z - playback.move.from.z) * playback.progress, zScale)
			: -height - displayZ(playback.move.from.z + (playback.move.to.z - playback.move.from.z) * playback.progress, zScale),
	] as [number, number, number] : null;
	const toolRadius = playback ? Math.max(playback.diameter / 2, 0.08) : 0.08;
	const toolLength = Math.max(1, (playback?.diameter ?? 0.2) * 5);

	return <>
		<lineSegments visible={showTravelPaths && viewSide === "top"} geometry={rapidTopGeometry} frustumCulled={false} renderOrder={5}>
			<lineBasicMaterial color="#80bfff" transparent opacity={0.28} depthWrite={false} />
		</lineSegments>
		<lineSegments visible={showTravelPaths && viewSide === "bottom"} geometry={rapidBottomGeometry} frustumCulled={false} renderOrder={5}>
			<lineBasicMaterial color="#80bfff" transparent opacity={0.28} depthWrite={false} />
		</lineSegments>
		{playback && playback.side === viewSide && (showTravelPaths || playback.move.type !== "rapid") && <lineSegments geometry={activeGeometry} frustumCulled={false} renderOrder={8}>
			<lineBasicMaterial color={playback.move.type === "rapid" ? "#a6d8ff" : "#f5c45f"} depthWrite={false} />
		</lineSegments>}
		{toolPosition && playback?.side === viewSide && <group position={toolPosition} rotation={[playback?.side === "bottom" ? -Math.PI / 2 : Math.PI / 2, 0, 0]} renderOrder={9}>
			<mesh position={[0, toolLength / 2, 0]}>
				<cylinderGeometry args={[toolRadius, toolRadius * 0.7, toolLength, 10]} />
				<meshStandardMaterial color="#f4c45e" emissive="#6c4b13" metalness={0.45} roughness={0.4} />
			</mesh>
			<mesh>
				<sphereGeometry args={[toolRadius * 1.2, 10, 8]} />
				<meshBasicMaterial color="#fff0bd" />
			</mesh>
		</group>}
	</>;
}

// BoxGeometry face group order: 0=+x, 1=-x, 2=+y, 3=-y, 4=+z (stock top), 5=-z (stock bottom).
// Face 4 (+Z) is removed — the displaced heightmap surface sits there instead.
function StockBox({ config, showBottomSurface }: { config: SceneConfig; showBottomSurface: boolean }) {
	const { stockWidth, stockDepth, stockHeight } = config;
	return (
		<mesh position={[0, 0, -stockHeight / 2]}>
			<boxGeometry args={[stockWidth, stockDepth, stockHeight]} />
			{[0, 1, 2, 3, 4, 5].map((i) =>
					i === 4 || (i === 5 && showBottomSurface) ? (
					<meshBasicMaterial
						key={i}
						attach={`material-${i}`}
						transparent
						opacity={0}
						depthWrite={false}
					/>
				) : (
					<meshStandardMaterial
						key={i}
						attach={`material-${i}`}
						color="#45634b"
						polygonOffset
						polygonOffsetFactor={2}
						polygonOffsetUnits={2}
					/>
				),
			)}
		</mesh>
	);
}

export interface SceneProps {
	heightmap: Heightmap | null;
	bottomHeightmap?: Heightmap | null;
	config: SceneConfig;
	reliefDepth?: number;
	backgroundColor?: string;
	viewSide?: "top" | "bottom";
	moves?: SceneMove[];
	showTravelPaths?: boolean;
	playback?: { move: GCodeMove; progress: number; diameter: number; side: "top" | "bottom" } | null;
}

export function Scene({ heightmap, bottomHeightmap = null, config, reliefDepth, backgroundColor = "#101211", viewSide = "top", moves = [], playback = null, showTravelPaths = false }: SceneProps) {
	const { stockWidth, stockDepth, stockHeight } = config;
	const d = Math.max(stockWidth, stockDepth, stockHeight);
	const depth = reliefDepth ?? heightmap?.minZ;
	const zScale = depth !== undefined && depth < 0
		? Math.max(1, (stockHeight * 0.42) / Math.abs(depth))
		: 1;

	return (
		<Canvas
			key={viewSide}
			camera={{
				position: [d * 0.9, -d * 0.9, (viewSide === "top" ? 1 : -1) * d * 0.8],
				up: [0, 0, viewSide === "top" ? 1 : -1],
				fov: 45,
				near: Math.max(0.01, d / 1000),
				far: d * 100,
			}}
			style={{ position: "absolute", inset: 0, background: backgroundColor }}
		>
			<ambientLight intensity={0.5} />
			<directionalLight position={[1, 1, 2]} intensity={1} />

			{heightmap && <HeightmapMesh heightmap={heightmap} config={config} zScale={zScale} side="top" />}
			{bottomHeightmap && <HeightmapMesh heightmap={bottomHeightmap} config={config} zScale={zScale} side="bottom" />}
			<StockBox config={config} showBottomSurface={Boolean(bottomHeightmap)} />
			{moves.length > 0 && <ToolpathOverlay moves={moves} width={stockWidth} depth={stockDepth} height={stockHeight} playback={playback} zScale={zScale} viewSide={viewSide} showTravelPaths={showTravelPaths} />}

			<OrbitControls makeDefault enableZoom minDistance={d * 0.2} maxDistance={d * 10} zoomSpeed={0.8} target={[0, 0, -stockHeight / 4]} />
			<GizmoHelper alignment="bottom-right" margin={[72, 72]}>
				<GizmoViewport axisColors={["#ef6464", "#79c879", "#639bff"]} labels={["X", "Y", "Z"]} labelColor="#101211" />
			</GizmoHelper>
		</Canvas>
	);
}
