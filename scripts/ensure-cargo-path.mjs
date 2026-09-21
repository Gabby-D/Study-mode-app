import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const cargoBin = join(homedir(), ".cargo", "bin");
const pathKey = platform() === "win32" ? "Path" : "PATH";
const separator = platform() === "win32" ? ";" : ":";
const env = { ...process.env };

const pathEntries = (env[pathKey] ?? "").split(separator).filter(Boolean);
if (!pathEntries.includes(cargoBin)) {
  env[pathKey] = [cargoBin, ...pathEntries].join(separator);
}

if (platform() === "win32") {
  applyMsvcEnvironment(env);
}

const args = ["tauri", ...process.argv.slice(2)];
const result = spawnSync("npx", args, {
  stdio: "inherit",
  env,
  shell: true,
});

process.exit(result.status ?? 1);

function applyMsvcEnvironment(targetEnv) {
  const vcvarsall = findVcvarsall();
  if (!vcvarsall) {
    return;
  }

  const hostArch = arch();
  const hasArm64Linker = hostArch === "arm64" && findHostLinker(vcvarsall, "Hostarm64", "arm64");
  let vcArch = "x64";
  if (hostArch === "arm64") {
    vcArch = hasArm64Linker ? "arm64" : "arm64_amd64";
    if (!hasArm64Linker) {
      targetEnv.RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc";
    }
  } else if (hostArch === "ia32") {
    vcArch = "x86";
  }

  const loaded = loadVcvarsEnv(vcvarsall, vcArch);
  for (const [key, value] of Object.entries(loaded)) {
    targetEnv[key] = value;
  }
}

function findVcvarsall() {
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vswhere)) {
    const result = spawnSync(
      vswhere,
      ["-latest", "-products", "*", "-find", "VC\\Auxiliary\\Build\\vcvarsall.bat"],
      { encoding: "utf8" },
    );
    const found = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && existsSync(line));
    if (found) {
      return found;
    }
  }

  const fallbacks = [
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat",
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat",
  ];
  return fallbacks.find((path) => existsSync(path));
}

function findHostLinker(vcvarsall, hostDir, targetDir) {
  const msvcRoot = join(dirname(vcvarsall), "..", "..", "Tools", "MSVC");
  if (!existsSync(msvcRoot)) {
    return false;
  }

  return readdirSync(msvcRoot).some((version) =>
    existsSync(join(msvcRoot, version, "bin", hostDir, targetDir, "link.exe")),
  );
}

function loadVcvarsEnv(vcvarsall, vcArch) {
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", `call "${vcvarsall}" ${vcArch} >nul && echo __ENV_START__ && set`],
    { encoding: "utf8", env: process.env },
  );
  if (result.status !== 0) {
    return {};
  }

  const output = result.stdout ?? "";
  const start = output.indexOf("__ENV_START__");
  const block = start === -1 ? output : output.slice(start + "__ENV_START__".length);
  const loaded = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      loaded[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return loaded;
}
