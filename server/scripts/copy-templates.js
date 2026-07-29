// tsc only compiles src/ -> dist/; the seed .docx/.xlsx templates under
// server/templates/ aren't TypeScript, so they need an explicit copy into
// dist/templates for both `npm start` locally and the deploy bundle
// (prepare-deploy.js copies dist/ verbatim).
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "templates");
const dest = path.join(__dirname, "..", "dist", "templates");

fs.mkdirSync(dest, { recursive: true });
for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (entry.isFile()) fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
}
console.log(`[copy-templates] copied ${src} -> ${dest}`);
