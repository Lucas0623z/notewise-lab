"use strict";

// Build artifact: preserve license texts for all installed production dependencies.
const fs = require("node:fs");
const path = require("node:path");
const frontend = path.resolve(__dirname, "../frontend");
const packages = new Map();

function locate(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return path.dirname(fs.realpathSync(candidate));
    if (path.dirname(directory) === directory) return null;
  }
}

function visit(name, from, optional = false) {
  const directory = locate(name, from);
  if (!directory) {
    if (optional) return;
    throw new Error(`Missing production dependency: ${name}`);
  }
  if (packages.has(directory)) return;
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  packages.set(directory, metadata);
  for (const dependency of Object.keys(metadata.dependencies || {})) visit(dependency, directory);
  for (const dependency of Object.keys(metadata.optionalDependencies || {})) visit(dependency, directory, true);
}

const root = JSON.parse(fs.readFileSync(path.join(frontend, "package.json"), "utf8"));
for (const name of Object.keys(root.dependencies)) visit(name, frontend);
const sections = ["THIRD-PARTY FRONTEND LICENSES\nGenerated from installed production dependencies.\n"];
const missing = [];
for (const [directory, metadata] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const licenseFiles = fs.readdirSync(directory).filter((name) =>
    /^(licen[cs]e|copying|notice|ofl)([._-]|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile());
  sections.push(`\n${"=".repeat(72)}\n${metadata.name} ${metadata.version}\nLicense: ${typeof metadata.license === "string" ? metadata.license : JSON.stringify(metadata.license)}\n${metadata.homepage || ""}\n`);
  if (!licenseFiles.length) missing.push(`${metadata.name}@${metadata.version}`);
  for (const filename of licenseFiles) sections.push(`\n--- ${filename} ---\n${fs.readFileSync(path.join(directory, filename), "utf8")}\n`);
}
const output = path.join(frontend, "build-resources", "licenses");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "FRONTEND-LICENSES.txt"), sections.join(""));
fs.writeFileSync(path.join(output, "frontend-package-manifest.json"), JSON.stringify(
  [...packages.values()].map(({name, version, license, homepage}) => ({name, version, license, homepage})), null, 2) + "\n");
console.log(JSON.stringify({ packages: packages.size, missingLicenseText: missing, output }));
if (missing.length) process.exitCode = 1;
