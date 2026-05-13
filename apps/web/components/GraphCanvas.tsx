"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { semanticEdgeColor } from "@/lib/edgeTiers";
import { useGraphStore } from "@/lib/store";

/**
 * 3D force-directed canvas — the memory-palace view.
 *
 * Notes:
 *  - Width/height are explicitly bound to the parent via ResizeObserver. Without
 *    this, react-force-graph defaults to window.innerWidth/Height and paints
 *    *over* the floating header.
 *  - Ambient particle field added to the scene for atmosphere.
 *  - Optional floor grid (Maya/Blender-style) for spatial reference.
 *  - Three.js can't SSR — we dynamic-import with ssr:false.
 */

const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-sm text-neutral-500">
      Spinning up your palace…
    </div>
  ),
});

const TYPE_COLOR: Record<string, string> = {
  note: "#22d3ee",
  doc: "#fbbf24",
  url: "#f472b6",
  cluster: "#a78bfa",
};
const FALLBACK_COLOR = "#7c5cff";
const SELECTED_COLOR = "#ffffff";
const MANUAL_EDGE_COLOR = "#3b3d52";

// Edge tiers + color function live in lib/edgeTiers.ts so the legend in
// GraphPageClient reads from the same source of truth (see import above).

type GNode = { id: string; type: string; title: string | null };
type GLink = {
  source: string;
  target: string;
  kind: "manual" | "semantic";
  weight: number;
};

type FGRef = {
  scene?: () => THREE.Scene;
  camera?: () => THREE.PerspectiveCamera;
  zoomToFit?: (duration?: number, padding?: number) => void;
};

export default function GraphCanvas({
  showGrid,
  fitTrigger,
}: {
  showGrid: boolean;
  /** Increment to re-run zoom-to-fit imperatively from the parent. */
  fitTrigger: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<FGRef | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  const dbNodes = useGraphStore((s) => s.nodes);
  const dbEdges = useGraphStore((s) => s.edges);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const selectNode = useGraphStore((s) => s.selectNode);

  // Keep the canvas sized to its parent (fixes the "canvas covers header" bug).
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      setSize({ width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Ambient particle field — slow drift around the graph.
  useEffect(() => {
    let frame: number | null = null;
    let points: THREE.Points | null = null;
    let geo: THREE.BufferGeometry | null = null;
    let mat: THREE.PointsMaterial | null = null;

    const tryAttach = () => {
      const scene = fgRef.current?.scene?.();
      if (!scene) return false;

      const count = 900;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        // Sphere shell, roughly r ∈ [250, 950]
        const r = 250 + Math.random() * 700;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
      }
      geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      mat = new THREE.PointsMaterial({
        color: 0x7c5cff,
        size: 1.6,
        transparent: true,
        opacity: 0.35,
        sizeAttenuation: true,
        depthWrite: false,
      });
      points = new THREE.Points(geo, mat);
      scene.add(points);

      let t = 0;
      const tick = () => {
        t += 0.0003;
        if (points) {
          points.rotation.y = t;
          points.rotation.x = t * 0.4;
        }
        frame = requestAnimationFrame(tick);
      };
      tick();
      return true;
    };

    // Poll until the force-graph ref is mounted (~100-300ms after mount).
    const wait = setInterval(() => {
      if (tryAttach()) clearInterval(wait);
    }, 100);

    return () => {
      clearInterval(wait);
      if (frame) cancelAnimationFrame(frame);
      if (points) fgRef.current?.scene?.()?.remove(points);
      geo?.dispose();
      mat?.dispose();
    };
  }, []);

  // Force-simulation tuning: bump link distance + charge repulsion so edges
  // have visible length and nodes don't pile on top of each other. d3-force
  // defaults are ~30 unit link distance / -30 charge — too cramped for a
  // small graph at our zoom level.
  useEffect(() => {
    let attempts = 0;
    const wait = setInterval(() => {
      attempts++;
      const fg = fgRef.current as unknown as {
        d3Force?: (name: string) => {
          distance?: (d: number) => unknown;
          strength?: (s: number) => unknown;
        } | null;
        resumeAnimation?: () => void;
      };
      if (!fg?.d3Force) {
        if (attempts > 20) clearInterval(wait);
        return;
      }
      clearInterval(wait);

      // Minimum desired distance between connected nodes.
      const linkForce = fg.d3Force("link");
      linkForce?.distance?.(80);

      // Stronger repulsion so unconnected nodes spread out.
      const chargeForce = fg.d3Force("charge");
      chargeForce?.strength?.(-150);

      // Forces only apply while the sim is running. Kick it back if cooled.
      fg.resumeAnimation?.();
    }, 100);
    return () => clearInterval(wait);
  }, []);

  // Continuous floating motion via the per-frame nodePositionUpdate callback
  // (passed to ForceGraph3D below). This is purely visual — we offset each
  // node's three.js position around its layout position with its own phase
  // and frequency so they don't oscillate in lockstep.
  //
  // Why this approach over a custom d3 force:
  // next/dynamic wraps the component and the lib's imperative ref methods
  // (d3Force / d3AlphaDecay / etc.) don't reliably forward through the
  // wrapper. The per-frame prop callback, on the other hand, definitely runs.

  // Optional floor grid (Maya/Blender vibe).
  useEffect(() => {
    if (!showGrid) return;
    let grid: THREE.GridHelper | null = null;

    const wait = setInterval(() => {
      const scene = fgRef.current?.scene?.();
      if (!scene) return;
      clearInterval(wait);
      grid = new THREE.GridHelper(3000, 60, 0x7c5cff, 0x2a2d3f);
      grid.position.y = -260;
      const m = grid.material as THREE.Material;
      m.transparent = true;
      m.opacity = 0.4;
      scene.add(grid);
    }, 100);

    return () => {
      clearInterval(wait);
      if (grid) {
        fgRef.current?.scene?.()?.remove(grid);
        grid.geometry.dispose();
        const m = grid.material as THREE.Material | THREE.Material[];
        Array.isArray(m) ? m.forEach((mm) => mm.dispose()) : m.dispose();
      }
    };
  }, [showGrid]);

  const data = useMemo(
    () => ({
      nodes: dbNodes.map<GNode>((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
      })),
      links: dbEdges.map<GLink>((e) => ({
        source: e.source_id,
        target: e.target_id,
        kind: e.kind,
        weight: e.weight ?? 0.5,
      })),
    }),
    [dbNodes, dbEdges],
  );

  // Padding in pixels controls how much empty margin sits around the
  // bounding box of all nodes. Smaller = tighter zoom. We aim for ~70%
  // cluster fill: 15% empty on each side of the smaller viewport dim.
  // Min 40px so tiny viewports don't crop the spheres against the edge.
  const fitPadding = Math.max(40, Math.min(size.width, size.height) * 0.15);

  // Auto-fit once the simulation has settled.
  useEffect(() => {
    if (dbNodes.length === 0) return;
    const t = setTimeout(() => fgRef.current?.zoomToFit?.(600, fitPadding), 800);
    return () => clearTimeout(t);
  }, [dbNodes.length, fitPadding]);

  // Imperative "Fit view" — bumped by the parent button.
  useEffect(() => {
    if (fitTrigger <= 0) return;
    fgRef.current?.zoomToFit?.(500, fitPadding);
  }, [fitTrigger, fitPadding]);

  return (
    <div ref={containerRef} className="h-full w-full">
      {/* @ts-expect-error - dynamic-imported component types don't carry through cleanly */}
      <ForceGraph3D
        ref={fgRef}
        graphData={data}
        width={size.width}
        height={size.height}
        backgroundColor="#0a0a0f"
        nodeRelSize={6}
        nodeOpacity={0.9}
        nodeResolution={20}
        nodeVal={(n: GNode) => (n.id === selectedNodeId ? 12 : 6)}
        nodeColor={(n: GNode) =>
          n.id === selectedNodeId
            ? SELECTED_COLOR
            : (TYPE_COLOR[n.type] ?? FALLBACK_COLOR)
        }
        nodeLabel={(n: GNode) =>
          `<div style="background:rgba(17,18,26,0.95);color:#e5e5e5;padding:6px 10px;border-radius:6px;font-size:11px;border:1px solid #2a2d3f;box-shadow:0 4px 12px rgba(0,0,0,0.5);">` +
          `<div style="opacity:0.6;text-transform:uppercase;letter-spacing:0.05em;font-size:9px;color:${TYPE_COLOR[n.type] ?? FALLBACK_COLOR}">${n.type}</div>` +
          `<div style="margin-top:2px">${escapeHtml(n.title || "Untitled")}</div>` +
          `</div>`
        }
        // Weight-modulated rendering: stronger semantic edges look stronger.
        // Color gradient (cool-dim → bright-magenta) for instant strength
        // readability; width/opacity/particles also scale with weight.
        // Manual edges keep a flat dim appearance.
        linkColor={(l: GLink) =>
          l.kind === "semantic"
            ? semanticEdgeColor(l.weight)
            : MANUAL_EDGE_COLOR
        }
        linkWidth={(l: GLink) =>
          l.kind === "semantic"
            ? 0.3 + Math.max(0, l.weight - 0.2) * 2.2
            : 0.4
        }
        linkOpacity={0.75}
        linkDirectionalParticles={(l: GLink) =>
          l.kind === "semantic" && l.weight >= 0.35
            ? Math.min(4, Math.ceil((l.weight - 0.2) * 5))
            : 0
        }
        linkDirectionalParticleSpeed={0.006}
        linkDirectionalParticleWidth={(l: GLink) =>
          l.kind === "semantic" ? 1.2 + l.weight * 1.5 : 1.5
        }
        linkDirectionalParticleColor={(l: GLink) =>
          l.kind === "semantic" ? semanticEdgeColor(l.weight) : "#a78bfa"
        }
        onNodeClick={(n: GNode) => selectNode(n.id)}
        onBackgroundClick={() => selectNode(null)}
        // enableNodeDrag intentionally OFF — works around a bug in
        // 3d-force-graph 1.80.x where DragControls' synthetic pointercancel
        // event gets forwarded to OrbitControls.onPointerUp, which tries to
        // read `.x` on it and crashes. The error fired on EVERY node click
        // (zero-distance drag = cancel). Selection still works because the
        // lib uses raycaster picking, not DragControls, for click detection.
        // Camera orbit / zoom / pan remain fully functional.
        enableNodeDrag={false}
        controlType="orbit"
        cooldownTicks={200}
        warmupTicks={50}
        nodePositionUpdate={(
          nodeObj: { position: { set: (x: number, y: number, z: number) => void } },
          _coords: { x: number; y: number; z: number },
          node: GNode & {
            __phase?: number;
            __freq?: number;
            __initTime?: number;
            __baseX?: number;
            __baseY?: number;
            __baseZ?: number;
            x?: number;
            y?: number;
            z?: number;
            fx?: number | null;
            fy?: number | null;
            fz?: number | null;
          },
        ) => {
          try {
            // While the user is dragging, the lib pins via fx/fy/fz. Honor that.
            if (node.fx != null && node.fy != null && node.fz != null) {
              nodeObj.position.set(node.fx, node.fy, node.fz);
              node.__baseX = node.fx;
              node.__baseY = node.fy;
              node.__baseZ = node.fz;
              return true;
            }

            // Initialize once per node. Defaults guard against NaN.
            if (node.__phase == null) {
              node.__phase = Math.random() * Math.PI * 2;
              node.__freq = 0.25 + Math.random() * 0.35;
              node.__initTime = performance.now();
            }
            const phase = node.__phase;
            const freq = node.__freq ?? 0.4;

            const now = performance.now();
            const elapsed = now - (node.__initTime ?? now);

            // 1.5s warmup: follow whatever the d3 sim places. During this
            // window we track the current sim position as the orbit center
            // so it ends up at the right spot when oscillation kicks in.
            if (elapsed < 1500) {
              const sx = Number.isFinite(node.x) ? (node.x as number) : 0;
              const sy = Number.isFinite(node.y) ? (node.y as number) : 0;
              const sz = Number.isFinite(node.z) ? (node.z as number) : 0;
              node.__baseX = sx;
              node.__baseY = sy;
              node.__baseZ = sz;
              nodeObj.position.set(sx, sy, sz);
              return true;
            }

            // After warmup: oscillate around locked base, and crucially
            // write the same value back to node.x/y/z so edges follow the
            // sphere instead of attaching to the orbit center.
            const baseX = node.__baseX ?? 0;
            const baseY = node.__baseY ?? 0;
            const baseZ = node.__baseZ ?? 0;
            const t = now / 1000;
            const amp = 8;

            const x = baseX + Math.sin(t * freq + phase) * amp;
            const y = baseY + Math.cos(t * freq * 1.1 + phase) * amp;
            const z = baseZ + Math.sin(t * freq * 0.9 + phase * 1.5) * amp;

            const fx = Number.isFinite(x) ? x : baseX;
            const fy = Number.isFinite(y) ? y : baseY;
            const fz = Number.isFinite(z) ? z : baseZ;
            nodeObj.position.set(fx, fy, fz);
            // The data position now matches the visual position, so the
            // lib's link drawing connects to the actual sphere center.
            node.x = fx;
            node.y = fy;
            node.z = fz;
            return true;
          } catch {
            return false;
          }
        }}
      />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
