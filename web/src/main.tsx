import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { detectLocale } from "./i18n.ts";
import { applyTheme, savedTheme } from "./theme.ts";
import "./styles.css";

document.documentElement.lang = detectLocale();
// Restores the saved theme and re-syncs the desktop shell's native appearance,
// so "system" clears a previous manual override there too.
void applyTheme(savedTheme());

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
