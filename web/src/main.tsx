import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { detectLocale } from "./i18n.ts";
import "./styles.css";

document.documentElement.lang = detectLocale();
const theme = localStorage.getItem("mingle.theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
else if (theme !== "system") document.documentElement.dataset.theme = "light";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
