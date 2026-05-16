"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { type ClusterIndex, buildClusters, buildClusterIndexFromDb } from "@/lib/clusters";
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
// Near-background tint for nodes/edges outside the focused cluster.
// Just above the canvas bg (#0a0a0f) so they're still hit-testable but
// visually recede. Aligned to palace-edge so it reads as "structural".
const DIMMED_NODE_COLOR = "#1f2230";
const DIMMED_LINK_COLOR = "#15171f";
// Glow color for the most-recently-created node. Bright amber/gold so it
// reads as "fresh" regardless of cluster color underneath.
const NEWEST_NODE_COLOR = "#fde047";  // yellow-300

/** Resolve a link endpoint id whether the lib has hydrated it to a node
 *  reference (post-sim) or kept it as a raw id string (pre-sim / pre-render). */
function endpointId(end: string | { id?: string }): string {
  return typeof end === "string" ? end : end?.id ?? "";
}

// Edge tiers + color function live in lib/edgeTiers.ts so the legend in
// GraphPageClient reads from the same source of truth (see import above).

type GNode = {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  /** Cluster color, when this node belongs to a cluster. null = singleton. */
  clusterColor: string | null;
  clusterLabel: string | null;
};
type GLink = {
  source: string;
  target: string;
  kind: "manual" | "semantic";
  weight: number;
  /** Endpoint titles materialized at data-build time for the hover tooltip. */
  sourceTitle: string;
  targetTitle: string;
};

type FGRef = {
  scene?: () => THREE.Scene;
  camera?: () => THREE.PerspectiveCamera;
  zoomToFit?: (duration?: number, padding?: number) => void;
  cameraPosition?: (
    pos: { x: number; y: number; z: number },
    lookAt?: { x: number; y: number; z: number },
    ms?: number,
  ) => void;
};

export default function GraphCanvas({
  showGrid,
  fitTrigger,
  flyToNodeId,
  flyToTrigger,
  onClustersChange,
  focusedClusterId,
}: {
  showGrid: boolean;
  /** Increment to re-run zoom-to-fit imperatively from the parent. */
  fitTrigger: number;
  /** Node id to fly the camera to when flyToTrigger changes. */
  flyToNodeId: string | null;
  /** Increment to re-trigger fly-to (so picking the same node twice re-flies). */
  flyToTrigger: number;
  /** Notified whenever the cluster index recomputes so the parent can render
   *  a legend without recomputing clusters itself. */
  onClustersChange?: (clusters: ClusterIndex["clusters"]) => void;
  /** When non-null, dim all nodes/edges not part of this cluster. The cluster
   *  legend in the parent toggles this. */
  focusedClusterId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<FGRef | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  const dbNodes = useGraphStore((s) => s.nodes);
  const dbEdges = useGraphStore((s) => s.edges);
  const dbClusters = useGraphStore((s) => s.dbClusters);
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

  // Cluster index — prefers DB-persisted (LLM-named) clusters when the
  // workspace has them, falls back to client-side connected-components on
  // weight-thresholded semantic edges. The fallback gives useful structure
  // before the user clicks "Recompute topics" the first time.
  const clusterIndex = useMemo(() => {
    if (dbClusters.length > 0) {
      return buildClusterIndexFromDb(dbNodes, dbClusters);
    }
    return buildClusters(dbNodes, dbEdges);
  }, [dbClusters, dbNodes, dbEdges]);

  // Notify parent about cluster set so it can render a legend.
  useEffect(() => {
    onClustersChange?.(clusterIndex.clusters);
  }, [clusterIndex, onClustersChange]);

  // Membership set of the focused cluster (if any), as a Set for O(1)
  // checks during the per-link / per-node opacity callbacks. Recomputed
  // only when the focus changes or the cluster index re-builds.
  const focusedMembers = useMemo(() => {
    if (!focusedClusterId) return null;
    const c = clusterIndex.clusters.find((x) => x.id === focusedClusterId);
    return c ? new Set(c.members) : null;
  }, [focusedClusterId, clusterIndex]);

  // The single most-recently-created node, by `created_at` desc. Gets a
  // glowing amber render so the user can spot the node they just added.
  // Stays "newest" until a newer node arrives — no time-fade in v1.
  const newestNodeId = useMemo<string | null>(() => {
    if (dbNodes.length === 0) return null;
    let newest = dbNodes[0];
    for (const n of dbNodes) {
      if (n.created_at > newest.created_at) newest = n;
    }
    return newest.id;
  }, [dbNodes]);

  // Radial-gradient texture used for the halo sprite around the newest
  // node. Built once via a canvas — bright amber center fading to fully
  // transparent at the edge. Combined with AdditiveBlending in the
  // SpriteMaterial below, this reads as a neon "bloom" on the dark bg
  // without needing a postprocessing pass on the renderer.
  const haloTexture = useMemo(() => {
    if (typeof document === "undefined") return null;       // SSR guard
    const size = 256;
    const cnv = document.createElement("canvas");
    cnv.width = size;
    cnv.height = size;
    const ctx = cnv.getContext("2d");
    if (!ctx) return null;
    const grad = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    // Color stops tuned so the center reads as a tight bright core and
    // the falloff is long + soft (no hard edge). Amber rgb(253, 224, 71).
    // Soft amber halo. Additive blending on a dark canvas effectively
    // doubles these alphas — keep them modest so the glow reads as
    // "highlight" rather than "sun."
    grad.addColorStop(0.0, "rgba(253, 224, 71, 0.75)");
    grad.addColorStop(0.55, "rgba(253, 224, 71, 0.55)");
    grad.addColorStop(0.9, "rgba(253, 224, 71, 0.1)");
    grad.addColorStop(1.0, "rgba(253, 224, 71, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cnv);
    tex.minFilter = THREE.LinearFilter;
    return tex;
  }, []);

  const data = useMemo(() => {
    const titleById = new Map<string, string>();
    for (const n of dbNodes) titleById.set(n.id, n.title || "(untitled)");
    return {
      nodes: dbNodes.map<GNode>((n) => {
        const c = clusterIndex.byNode.get(n.id) ?? null;
        return {
          id: n.id,
          type: n.type,
          title: n.title,
          content: n.content,
          clusterColor: c?.color ?? null,
          clusterLabel: c?.label ?? null,
        };
      }),
      links: dbEdges.map<GLink>((e) => ({
        source: e.source_id,
        target: e.target_id,
        kind: e.kind,
        weight: e.weight ?? 0.5,
        sourceTitle: titleById.get(e.source_id) ?? "(unknown)",
        targetTitle: titleById.get(e.target_id) ?? "(unknown)",
      })),
    };
  }, [dbNodes, dbEdges, clusterIndex]);

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

  // Imperative camera fly-to-node — bumped when a search match is picked.
  // We read the node's three.js position (set by the d3 sim + per-frame
  // oscillation in nodePositionUpdate). It's `node.x/y/z` on the data array
  // entry. The lib mutates these in place each tick.
  useEffect(() => {
    if (flyToTrigger <= 0 || !flyToNodeId) return;
    const target = (data.nodes as Array<GNode & { x?: number; y?: number; z?: number }>).find(
      (n) => n.id === flyToNodeId,
    );
    if (!target || target.x == null) return;
    const distance = 200;
    // Pull the camera back along the +Z axis from the node so the user sees
    // the node head-on (rather than landing inside it).
    const cam = {
      x: target.x,
      y: target.y ?? 0,
      z: (target.z ?? 0) + distance,
    };
    const lookAt = { x: target.x, y: target.y ?? 0, z: target.z ?? 0 };
    fgRef.current?.cameraPosition?.(cam, lookAt, 700);
  }, [flyToTrigger, flyToNodeId, data.nodes]);

  return (
    <div ref={containerRef} className="h-full w-full">
      <ForceGraph3D
        ref={fgRef}
        graphData={data}
        width={size.width}
        height={size.height}
        backgroundColor="#0a0a0f"
        nodeRelSize={6}
        nodeOpacity={0.9}
        nodeResolution={20}
        // Glow halo around the newest node. We REPLACE the lib's default
        // mesh (no nodeThreeObjectExtend) with a Group containing our own
        // sphere + an additively-blended halo sprite — so the per-tick
        // nodePositionUpdate callback moves both together as one unit.
        // With extend=true the sprite stayed at the d3-force initial
        // position while the sphere oscillated away — looked like two
        // separate nodes. One Group, one position.
        nodeThreeObject={(n: GNode) => {
          // Only the newest node gets a custom object. For everyone else
          // return null → the lib renders its default sphere using our
          // nodeColor/nodeVal callbacks.
          //
          // For the newest node we REPLACE the default (extend=false /
          // unset) and return a single Group containing the sphere AND
          // its halo sprite. Why replace vs extend: the lib's per-tick
          // `nodePositionUpdate` only moves the default mesh — with
          // extend=true our sprite would drift away from the moving
          // sphere. One unified Group keeps everything at the same spot.
          if (!haloTexture || n.id !== newestNodeId) return null;
          const group = new THREE.Group();
          // Sphere: match the look of nodeVal=14 + nodeRelSize=6 so the
          // newest node visually reads as "bigger" without being absurd.
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(14, 20, 20),
            new THREE.MeshLambertMaterial({
              color: NEWEST_NODE_COLOR,
              transparent: true,
              opacity: 0.95,
              // emissive nudges self-lighting so the sphere stays bright
              // even without scene lights hitting it.
              emissive: NEWEST_NODE_COLOR,
              emissiveIntensity: 0.45,
            }),
          );
          group.add(sphere);
          // Halo sprite — additive-blended, sized ~3.5× sphere radius.
          // Soft glow, not a sun.
          const halo = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: haloTexture,
              transparent: true,
              opacity: 0.75,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          halo.scale.set(50, 50, 1);
          group.add(halo);
          return group;
        }}
        nodeVal={(n: GNode) =>
          n.id === selectedNodeId ? 12 : n.id === newestNodeId ? 14 : 6
        }
        nodeColor={(n: GNode) => {
          if (n.id === selectedNodeId) return SELECTED_COLOR;
          // When a cluster is focused, dim non-members by returning a
          // near-background color. This is a stronger signal than tweaking
          // opacity (which the lib only supports uniformly). Newest node
          // is exempt — its glow should be visible even during focus.
          if (
            focusedMembers &&
            !focusedMembers.has(n.id) &&
            n.id !== newestNodeId
          ) {
            return DIMMED_NODE_COLOR;
          }
          // Glow color for the most-recently-created node beats cluster
          // color — the "this is new" signal trumps the "this belongs to
          // topic X" signal until the user adds another node.
          if (n.id === newestNodeId) return NEWEST_NODE_COLOR;
          // Cluster color wins over type color when the node belongs to a
          // cluster (size >= 2 of weight-thresholded semantic neighbors).
          // Singletons fall back to type-color so the canvas doesn't go drab.
          return n.clusterColor ?? TYPE_COLOR[n.type] ?? FALLBACK_COLOR;
        }}
        nodeLabel={(n: GNode) => {
          // Inlined helpers — react-force-graph re-evaluates callbacks in a
          // way that loses references to module-scoped functions after Fast
          // Refresh. Keep everything self-contained.
          const esc = (s: string) =>
            s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
          const trunc = (s: string, m: number) => (s.length <= m ? s : s.slice(0, m - 1) + "…");

          const accent = n.clusterColor ?? TYPE_COLOR[n.type] ?? FALLBACK_COLOR;
          const preview = (n.content || "").trim();
          const previewHtml = preview
            ? `<div style="margin-top:6px;color:#a3a3a3;line-height:1.35;max-width:320px">${esc(trunc(preview, 220))}</div>`
            : `<div style="margin-top:6px;color:#525252;font-style:italic">no content</div>`;
          const clusterLine = n.clusterLabel
            ? `<div style="margin-top:4px;font-size:9px;color:${accent};opacity:0.85">cluster: ${esc(n.clusterLabel)}</div>`
            : "";
          return (
            `<div style="background:rgba(17,18,26,0.96);color:#e5e5e5;padding:8px 12px;border-radius:8px;font-size:11px;border:1px solid #2a2d3f;box-shadow:0 6px 18px rgba(0,0,0,0.6);max-width:340px">` +
            `<div style="opacity:0.65;text-transform:uppercase;letter-spacing:0.05em;font-size:9px;color:${accent}">${n.type}</div>` +
            `<div style="margin-top:2px;font-weight:500">${esc(n.title || "Untitled")}</div>` +
            clusterLine +
            previewHtml +
            `</div>`
          );
        }}
        linkLabel={(l: GLink) => {
          const esc = (s: string) =>
            s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
          const trunc = (s: string, m: number) => (s.length <= m ? s : s.slice(0, m - 1) + "…");

          const pct = `${(l.weight * 100).toFixed(0)}%`;
          const kindBadge =
            l.kind === "semantic"
              ? `<span style="color:${semanticEdgeColor(l.weight)};text-transform:uppercase;font-size:9px;letter-spacing:0.05em">semantic</span>`
              : `<span style="color:#94a3b8;text-transform:uppercase;font-size:9px;letter-spacing:0.05em">manual</span>`;
          return (
            `<div style="background:rgba(17,18,26,0.96);color:#e5e5e5;padding:6px 10px;border-radius:6px;font-size:11px;border:1px solid #2a2d3f;box-shadow:0 4px 12px rgba(0,0,0,0.5);max-width:320px">` +
            `<div style="display:flex;align-items:baseline;gap:8px">${kindBadge}<span style="opacity:0.6">weight</span><span style="font-weight:500">${pct}</span></div>` +
            `<div style="margin-top:4px;color:#a3a3a3;font-size:10px">${esc(trunc(l.sourceTitle, 60))} ↔ ${esc(trunc(l.targetTitle, 60))}</div>` +
            `</div>`
          );
        }}
        // Weight-modulated rendering: stronger semantic edges look stronger.
        // Color gradient (cool-dim → bright-magenta) for instant strength
        // readability; width/particles also scale with weight.
        // Manual edges keep a flat dim appearance.
        // When a cluster is focused, only edges with BOTH endpoints in the
        // cluster keep their full appearance. Bridging edges and outside
        // edges fade to near-bg so the cluster's internal structure pops.
        linkColor={(l: GLink) => {
          if (focusedMembers) {
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (!focusedMembers.has(a) || !focusedMembers.has(b)) {
              return DIMMED_LINK_COLOR;
            }
          }
          return l.kind === "semantic"
            ? semanticEdgeColor(l.weight)
            : MANUAL_EDGE_COLOR;
        }}
        linkWidth={(l: GLink) => {
          if (focusedMembers) {
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (!focusedMembers.has(a) || !focusedMembers.has(b)) return 0.2;
          }
          return l.kind === "semantic"
            ? 0.3 + Math.max(0, l.weight - 0.2) * 2.2
            : 0.4;
        }}
        linkOpacity={0.75}
        linkDirectionalParticles={(l: GLink) => {
          // Kill particle traffic on dimmed edges — animation noise where
          // we want quiet.
          if (focusedMembers) {
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (!focusedMembers.has(a) || !focusedMembers.has(b)) return 0;
          }
          return l.kind === "semantic" && l.weight >= 0.35
            ? Math.min(4, Math.ceil((l.weight - 0.2) * 5))
            : 0;
        }}
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

