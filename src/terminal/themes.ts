/**
 * Named colour schemes for terminal demos.
 *
 * The emulator resolves SGR 30–37/40–47/90–97 and the low end of the 256-colour
 * cube through a 16-entry palette. Those sixteen values were hardcoded, so every
 * demo came out in one scheme no matter what the surrounding page looked like —
 * a light-themed spec still rendered its terminal in dark GitHub colours.
 *
 * Each theme carries the palette *and* its own background and foreground,
 * because the three are designed together: Solarized's contrast only works
 * against its own base tones. A spec that sets `background` or `foreground`
 * explicitly still wins, so a theme is a starting point rather than a cage.
 *
 * Palettes are the published values for each scheme, ordered the way a terminal
 * indexes them: eight normal colours (black, red, green, yellow, blue, magenta,
 * cyan, white) then the eight bright variants.
 */

export interface TerminalTheme {
  background: string;
  foreground: string;
  /** The 16 ANSI colours: 8 normal, then 8 bright. */
  palette: readonly string[];
}

export const TERMINAL_THEMES = {
  /** Reel's own scheme — the palette terminal demos used before themes existed. */
  reel: {
    background: "#0b0d12",
    foreground: "#c9d1d9",
    palette: [
      "#1e2029", "#f0616e", "#7ee787", "#f0c674",
      "#79b8ff", "#d2a8ff", "#56d4dd", "#c9d1d9",
      "#5a6172", "#ff8a94", "#a2f2a9", "#ffe08a",
      "#a5d6ff", "#e2c5ff", "#8ff0f5", "#ffffff",
    ],
  },
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    palette: [
      "#21222c", "#ff5555", "#50fa7b", "#f1fa8c",
      "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
      "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
      "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
    ],
  },
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    palette: [
      "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
    ],
  },
  "catppuccin-mocha": {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    palette: [
      "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
      "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
    ],
  },
  "tokyo-night": {
    background: "#1a1b26",
    foreground: "#c0caf5",
    palette: [
      "#15161e", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
      "#414868", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
    ],
  },
  "gruvbox-dark": {
    background: "#282828",
    foreground: "#ebdbb2",
    palette: [
      "#282828", "#cc241d", "#98971a", "#d79921",
      "#458588", "#b16286", "#689d6a", "#a89984",
      "#928374", "#fb4934", "#b8bb26", "#fabd2f",
      "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
    ],
  },
  "one-dark": {
    background: "#282c34",
    foreground: "#abb2bf",
    palette: [
      "#282c34", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
      "#5c6370", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#ffffff",
    ],
  },
  "solarized-dark": {
    background: "#002b36",
    foreground: "#839496",
    palette: [
      "#073642", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83",
      "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  },
  /*
   * Two light schemes, because `theme: light` specs exist and a dark terminal
   * dropped into a light page is the most obvious way a demo looks unfinished.
   */
  "solarized-light": {
    background: "#fdf6e3",
    foreground: "#657b83",
    palette: [
      "#073642", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83",
      "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  },
  "github-light": {
    background: "#ffffff",
    foreground: "#24292f",
    palette: [
      "#24292f", "#cf222e", "#116329", "#4d2d00",
      "#0969da", "#8250df", "#1b7c83", "#6e7781",
      "#57606a", "#a40e26", "#1a7f37", "#633c01",
      "#218bff", "#a475f9", "#3192aa", "#8c959f",
    ],
  },
} as const satisfies Record<string, TerminalTheme>;

export type TerminalThemeName = keyof typeof TERMINAL_THEMES;

/** Theme names, for the schema's enum and for `reel themes`. */
export const THEME_NAMES = Object.keys(TERMINAL_THEMES) as [
  TerminalThemeName,
  ...TerminalThemeName[],
];

export const DEFAULT_THEME: TerminalThemeName = "reel";

/** The palette the emulator falls back to when constructed without one. */
export const DEFAULT_PALETTE: readonly string[] = TERMINAL_THEMES.reel.palette;
