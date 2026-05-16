/**
 * Discrete strength tiers for semantic edges. Single source of truth for both
 * the GraphCanvas (renders edges in these colors) and the legend in
 * GraphPageClient (shows which color means what).
 *
 * Lives in lib/ rather than the component file because Next.js can be
 * particular about non-component named exports from "use client" modules.
 *
 *   weak:    0.30 ≤ w < 0.40   slate  (#64748b) — barely-there structure
 *   medium:  0.40 ≤ w < 0.50   cyan   (#22d3ee) — decent semantic match
 *   strong:        w ≥ 0.50    amber  (#fbbf24) — confident semantic match
 *
 * Bottom matches the server-side `min_weight` floor in rebuild_semantic_edges
 * (raised 0.25 → 0.30 after audit caught spurious low-weight links between
 * agent-saved notes and unrelated summaries). Edges below 0.30 never get
 * inserted in the first place.
 */
export const EDGE_TIERS = {
  weak: { min: 0.3, color: "#64748b", label: "weak" },
  medium: { min: 0.4, color: "#22d3ee", label: "medium" },
  strong: { min: 0.5, color: "#fbbf24", label: "strong" },
} as const;

export function semanticEdgeColor(weight: number): string {
  if (weight >= EDGE_TIERS.strong.min) return EDGE_TIERS.strong.color;
  if (weight >= EDGE_TIERS.medium.min) return EDGE_TIERS.medium.color;
  return EDGE_TIERS.weak.color;
}
