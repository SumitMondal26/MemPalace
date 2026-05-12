import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Memory Palace tone: deep, neural, ambient.
        palace: {
          bg: "#0a0a0f",
          panel: "#11121a",
          edge: "#2a2d3f",
          accent: "#7c5cff",
        },
      },
    },
  },
  plugins: [],
};

export default config;
