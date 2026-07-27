import "@ui5/webcomponents-react/dist/Assets";
// The Assets bundle above only registers icon accessible-name text, not the
// icon glyphs themselves — @ui5/webcomponents-icons ships path data as
// separate lazily-loadable modules, and without an explicit static import
// per icon name, no loader is ever registered for its collection at all.
// The visible symptom isn't just a missing glyph: the underlying ui5-icon
// web component retries the failed load on every one of its own re-renders,
// which becomes a tight, unbounded, silent console-error loop for any
// `icon="..."` prop used anywhere in the app. Import every icon name this
// app actually references (kept in sync manually — grep for `icon="` in
// web/src if a new one is ever added) rather than the much larger AllIcons
// bundle, which would pull in all ~700 icons.
import "@ui5/webcomponents-icons/dist/add.js";
import "@ui5/webcomponents-icons/dist/bar-chart.js";
import "@ui5/webcomponents-icons/dist/delete.js";
import "@ui5/webcomponents-icons/dist/list.js";
import "@ui5/webcomponents-icons/dist/refresh.js";
import { ThemeProvider } from "@ui5/webcomponents-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
