import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0d12",
        bg2: "#0e1119",
        panel: "#151823",
        panel2: "#1a1e2b",
        elev: "#1f2434",
        /* Boundaries. Both were inside a 1.07–1.67 contrast band against every
           surface they sit on, which is why controls had no edge to find and
           the whole UI read as one flat sheet. `line` now clears 3:1 against
           the darkest surface it borders (bg #0b0d12) so a card, an input and a
           divider are all separable; `line2` stays the brighter of the two for
           hover and for the controls that need to look raised. */
        line: "#454d63",
        line2: "#646f8a",
        ink: "#e9ecf5",
        muted: "#98a1b8",
        /* #6b7488 measured 3.29–4.15:1 across the app's surfaces — below AA, on
           text that carries real content (hints, paths, counts, empty-state
           copy). #838ca0 clears 4.5:1 on every one of them, elev included. */
        faint: "#838ca0",
        brand: "#6d8bff",
        brand2: "#7cf3c4",
        ok: "#4ade80",
        warn: "#fbbf24",
        err: "#f87171",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Inter",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      backgroundImage: {
        brand: "linear-gradient(135deg, #6d8bff, #7cf3c4)",
        "brand-soft":
          "linear-gradient(135deg, rgba(109,139,255,0.16), rgba(124,243,196,0.16))",
      },
      boxShadow: {
        glow: "0 10px 30px rgba(109,139,255,0.28)",
        panel: "0 18px 50px rgba(0,0,0,0.4)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.4s ease both",
        shimmer: "shimmer 1.4s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
