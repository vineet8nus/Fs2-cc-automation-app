// Assembles a minimal, pre-built deploy/ directory for `cf push`: the
// compiled server (which already embeds the built frontend under
// dist/public — see copy-frontend.js) plus a runtime-only package.json
// with no build/postinstall hooks. This sidesteps CF nodejs_buildpack
// quirks around its own node_modules cache short-circuiting `npm install`
// before devDependencies (tsc/vite) are available for an in-buildpack build.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const serverDist = path.join(root, "server", "dist");
const deployDir = path.join(root, "deploy");
const serverPkg = require(path.join(root, "server", "package.json"));

if (!fs.existsSync(serverDist)) {
  console.error("[prepare-deploy] server/dist not found — run `npm run build` first.");
  process.exit(1);
}
if (!fs.existsSync(path.join(serverDist, "public", "index.html"))) {
  console.error("[prepare-deploy] server/dist/public/index.html not found — frontend wasn't copied in.");
  process.exit(1);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(deployDir, { recursive: true, force: true });
copyDir(serverDist, deployDir);

const deployPkg = {
  name: "fs2-cc-automation-app",
  version: serverPkg.version,
  private: true,
  engines: { node: "22.x" },
  main: "index.js",
  scripts: { start: "node index.js" },
  dependencies: serverPkg.dependencies,
};
fs.writeFileSync(path.join(deployDir, "package.json"), JSON.stringify(deployPkg, null, 2));

console.log(`[prepare-deploy] wrote ${deployDir} (${Object.keys(deployPkg.dependencies).length} runtime deps, no build hooks)`);
