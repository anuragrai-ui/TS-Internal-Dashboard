"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "ts-dashboard-theme";
const META_SELECTOR = "meta[name=\"color-scheme\"]";

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector(META_SELECTOR);
  if (meta) {
    meta.setAttribute("content", theme);
  }
}

function subscribeToSystemTheme(callback: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", callback);
  return () => {
    media.removeEventListener("change", callback);
  };
}

function getSystemThemeSnapshot(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }
  return getSystemTheme();
}

export function ThemeToggle(): React.ReactElement {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");

  const systemTheme = useSyncExternalStore<Theme>(
    subscribeToSystemTheme,
    getSystemThemeSnapshot,
    () => "light",
  );

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const nextTheme: Theme =
      stored === "light" || stored === "dark" ? stored : systemTheme;
    setTheme(nextTheme);
    applyTheme(nextTheme);
    setMounted(true);
  }, [systemTheme]);

  const handleToggle = (): void => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    applyTheme(nextTheme);
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
  };

  const isDark = mounted ? theme === "dark" : false;

  return (
    <button
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
      className="theme-toggle"
      onClick={handleToggle}
      type="button"
    >
      <span aria-hidden="true" className="theme-toggle-track">
        <span className="theme-toggle-thumb" />
      </span>
      <span>{isDark ? "Dark" : "Light"}</span>
    </button>
  );
}
