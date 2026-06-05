import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const cargoBin = join(homedir(), ".cargo", "bin");
const pathKey = platform() === "win32" ? "Path" : "PATH";
const separator = platform() === "win32" ? ";" : ":";
const env = { ...process.env };

const pathEntries = (env[pathKey] ?? "").split(separator).filter(Boolean);
if (!pathEntries.includes(cargoBin)) {
  env[pathKey] = [cargoBin, ...pathEntries].join(separator);
}

const args = ["tauri", ...process.argv.slice(2)];
const result = spawnSync("npx", args, {
  stdio: "inherit",
  env,
  shell: true,
});

process.exit(result.status ?? 1);
