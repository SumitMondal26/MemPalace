// Dead-code stub.
//
// This file used to be a React Flow node renderer (back when we planned to
// use @xyflow/react). We switched to react-force-graph-3d for the 3D canvas
// (see GraphCanvas.tsx) and never imported NodeCard anywhere. It got left
// behind importing a package that's no longer in package.json, which broke
// `next build` (strict type-check).
//
// Keeping the file as an empty stub so the path isn't surprising for anyone
// who has it open in their editor or referenced in a git history search.
// Safe to delete entirely; just confirm with `grep -r "NodeCard" .` first.
export {};
