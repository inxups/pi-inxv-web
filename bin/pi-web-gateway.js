#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  process.stderr.write(`${getUnsupportedNodeVersionMessage(process.versions.node)}\n`);
  process.exit(1);
}

const cli = path.join(__dirname, "..", "gateway", "cli.mts");
const args = process.argv.slice(2);
const child = spawn(process.execPath, [
  "--experimental-strip-types",
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
  "--disable-warning=ExperimentalWarning",
  cli,
  ...args,
], {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
  env: process.env,
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`[pi-web-gateway] failed to start: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (!stopping && signal) {
    process.stderr.write(`[pi-web-gateway] exited with signal ${signal}\n`);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
