import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cssPath = resolve(import.meta.dirname, "../app/globals.css");
const css = readFileSync(cssPath, "utf-8");

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

function extractRuleBlock(selector: string): string {
  const index = css.indexOf(selector);
  if (index === -1) {
    throw new Error(`Selector not found: ${selector}`);
  }
  const start = index + selector.length;
  const end = css.indexOf("}", start);
  if (end === -1) {
    throw new Error(`Unclosed rule for selector: ${selector}`);
  }
  return css.slice(start, end + 1);
}

console.log("\n--- Test: Theme toggle CSS palettes ---");

const rootBlock = extractRuleBlock(":root {");
assert(
  rootBlock.includes("color-scheme: light dark"),
  ":root should declare light dark color-scheme support",
);
assert(
  rootBlock.includes("--bg: #f6f7f9"),
  "Light mode background should be the Pylon-style cool gray canvas (#f6f7f9)",
);
assert(
  rootBlock.includes("--surface: #ffffff"),
  "Light mode surface should be white (#ffffff)",
);
assert(
  rootBlock.includes("--accent: #4f46e5"),
  "Light mode accent should be the Pylon-style indigo (#4f46e5)",
);

const darkBlock = extractRuleBlock(':root[data-theme="dark"] {');
assert(
  darkBlock.includes("color-scheme: dark"),
  "Dark mode should set color-scheme to dark",
);
assert(
  darkBlock.includes("--bg: #0f1115"),
  "Dark mode background should be the Pylon-style dark neutral (#0f1115)",
);
assert(
  darkBlock.includes("--accent: #818cf8"),
  "Dark mode accent should be the Pylon-style dark-mode indigo (#818cf8)",
);

const lightOverride = extractRuleBlock(':root[data-theme="light"] {');
assert(
  lightOverride.includes("color-scheme: light"),
  "Light mode override should set color-scheme to light",
);
assert(
  lightOverride.includes("--bg: #f6f7f9"),
  "Light mode override should keep the light canvas",
);

const appShell = extractRuleBlock(".app-shell {");
assert(
  appShell.includes("display: flex"),
  "App shell should lay the sidebar and main column out with flexbox",
);

const sidebar = extractRuleBlock(".app-sidebar {");
assert(
  sidebar.includes("position: sticky"),
  "Sidebar should stay fixed in view while content scrolls",
);

const dataTable = extractRuleBlock(".data-table thead th {");
assert(
  dataTable.includes("position: sticky"),
  "Data table header should stick while rows scroll",
);

const drawer = extractRuleBlock(".drawer-panel {");
assert(
  drawer.includes("position: fixed"),
  "Issue detail drawer should be a fixed-position slide-over panel",
);

const prefersDark = css.indexOf("@media (prefers-color-scheme: dark)");
assert(
  prefersDark !== -1,
  "CSS should respect prefers-color-scheme for system dark mode",
);

const reducedMotion = css.indexOf("@media (prefers-reduced-motion: reduce)");
assert(
  reducedMotion !== -1,
  "CSS should respect prefers-reduced-motion",
);

console.log("PASS: Enterprise console theme and shell styles are present.");
console.log("\nAll theme tests passed.");
