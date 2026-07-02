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
  rootBlock.includes("--bg: #f8f9fa"),
  "Light mode background should be Argon light gray (#f8f9fa)",
);
assert(
  rootBlock.includes("--surface: #ffffff"),
  "Light mode surface should be white (#ffffff)",
);
assert(
  rootBlock.includes("--accent: #5e72e4"),
  "Light mode accent should be Argon blue (#5e72e4)",
);

const darkBlock = extractRuleBlock(':root[data-theme="dark"] {');
assert(
  darkBlock.includes("color-scheme: dark"),
  "Dark mode should set color-scheme to dark",
);
assert(
  darkBlock.includes("--bg: #0f172a"),
  "Dark mode background should be slate-900 (#0f172a)",
);
assert(
  darkBlock.includes("--accent: #7a8bf8"),
  "Dark mode accent should be light purple (#7a8bf8)",
);

const lightOverride = extractRuleBlock(':root[data-theme="light"] {');
assert(
  lightOverride.includes("color-scheme: light"),
  "Light mode override should set color-scheme to light",
);
assert(
  lightOverride.includes("--bg: #f8f9fa"),
  "Light mode override should keep Argon light gray background",
);

const darkThumb = extractRuleBlock(':root[data-theme="dark"] .theme-toggle-thumb');
assert(
  darkThumb.includes("background: var(--accent)"),
  "Dark mode toggle thumb should use accent color",
);
assert(
  darkThumb.includes("transform: translateX(1.125rem)"),
  "Dark mode toggle thumb should slide to the right",
);

const hero = extractRuleBlock(".hero-gradient {");
assert(
  hero.includes("background: linear-gradient(135deg, var(--accent) 0%, #825ee4 100%)"),
  "Hero should use Argon purple-blue gradient",
);

const statCard = extractRuleBlock(".stat-card {");
assert(
  statCard.includes("border-radius: var(--radius-xl)"),
  "Stat cards should have rounded corners",
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

console.log("PASS: Argon-style theme and component styles are present.");
console.log("\nAll theme tests passed.");
