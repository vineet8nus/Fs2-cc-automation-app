// Copies the built web (Vite) output into server/dist/public so the Express
// server can serve the Fiori-consistent frontend as static assets alongside
// the REST API in a single deployable CF app.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "web", "dist");
const dest = path.join(__dirname, "..", "server", "dist", "public");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(src)) {
  console.error(`[copy-frontend] web/dist not found at ${src} — did the web build run?`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);
console.log(`[copy-frontend] copied ${src} -> ${dest}`);
