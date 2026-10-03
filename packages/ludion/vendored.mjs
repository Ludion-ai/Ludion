// The packages `ludion` carries in its tarball (ADR-036): npm gets the one name, `ludion`, and these
// stay private in the repository. build.mjs copies them into lib/ at prepack (package.json's `exports`
// point into lib/ for ludion/diver and ludion/gate/{node,next,workers}); PUB-1..4 hold the set.
export const VENDORED = ["diver", "scan", "report", "gate-core", "gate-node", "gate-next", "gate-workers"];
