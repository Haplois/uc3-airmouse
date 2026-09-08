.pragma library
var names = ["violet", "glacier", "mint", "amber", "graphite", "black"];
var palettes = {
    violet: { name: "Violet", bg: "#181621", card: "#242130", line: "#423b54", fg: "#f4efff", muted: "#b2a8c5", accent: "#c7afff", ink: "#251840", monitor: "#45315e" },
    glacier: { name: "Glacier", bg: "#101a26", card: "#1a293a", line: "#334b65", fg: "#edf5ff", muted: "#a5bad2", accent: "#9acbff", ink: "#102944", monitor: "#254564" },
    mint: { name: "Mint", bg: "#101e1b", card: "#1b2d28", line: "#345148", fg: "#edf8f1", muted: "#a5c0b4", accent: "#9ce0bd", ink: "#153a29", monitor: "#2b4a3d" },
    amber: { name: "Amber", bg: "#201a13", card: "#30271c", line: "#53432c", fg: "#faf2e4", muted: "#c6b494", accent: "#efc078", ink: "#3b2910", monitor: "#544022" },
    graphite: { name: "Graphite", bg: "#17191c", card: "#25282d", line: "#434850", fg: "#f1f3f6", muted: "#b3bac4", accent: "#d0d7e2", ink: "#242a33", monitor: "#3c424b" },
    black: { name: "True black", bg: "#000000", card: "#000000", line: "#606060", fg: "#ffffff", muted: "#b8b8b8", accent: "#eeeeee", ink: "#000000", monitor: "#000000" }
};
function get(name) { return palettes[name] || palettes.black; }
