/**
 * Discrete strength tiers for semantic edges. Single source of truth for both
 * the GraphCanvas (renders edges in these colors) and the legend in
 * GraphPageClient (shows which color means what).
 *
 * Lives in lib/ rather than the component file because Next.js can be
 * particular about non-component named exports from "use client" modules.
 *
 *   weak:    0.25 ≤ w < 0.40   slate  (#64748b) — barely-there structure
 *   medium:  0.40 ≤ w < 0.50   cyan   (#22d3ee) — decent semantic match
 *   strong:        w ≥ 0.50    amber  (#fbbf24) — confident semantic match
 */
export const EDGE_TIERS = {
  weak: { min: 0.25, color: "#64748b", label: "weak" },
  medium: { min: 0.4, color: "#22d3ee", label: "medium" },
  strong: { min: 0.5, color: "#fbbf24", label: "strong" },
} as const;

export function semanticEdgeColor(weight: number): string {
  if (weight >= EDGE_TIERS.strong.min) return EDGE_TIERS.strong.color;
  if (weight >= EDGE_TIERS.medium.min) return EDGE_TIERS.medium.color;
  return EDGE_TIERS.weak.color;
}
