import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = { darwin: "osx-bin", linux: "linux64-bin", win32: "win64-bin" }[process.platform];
if (!platform) throw new Error("The mobile syntax check needs a supported Hermes compiler.");
const compiler = join(root, "node_modules/react-native/sdks/hermesc", platform, process.platform === "win32" ? "hermesc.exe" : "hermesc");
const modules = new Map();

async function visit(file) {
  if (modules.has(file)) return;
  const source = await readFile(file, "utf8");
  // Keep classes intact and lower async functions, matching the relevant
  // behavior of Paseo's bundle. Metro does not transform loaded plugins.
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2015, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, useDefineForClassFields: false,
  } }).outputText;
  modules.set(file, output);
  for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
    if (!imported.fileName.startsWith(".")) continue;
    const base = resolve(dirname(file), imported.fileName);
    let resolved;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      try { await readFile(candidate); resolved = candidate; break; } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
      }
    }
    if (!resolved) throw new Error(`Could not resolve client import ${imported.fileName}.`);
    await visit(resolved);
  }
}

await visit(join(root, "index.client.tsx"));
const source = `"use strict";\nvar clientModules = [\n${[...modules].map(([file, code]) =>
  `// ${relative(root, file)}\nfunction(require, module, exports) {\n${code}\n}`,
).join(",\n")}\n];\n`;
const temporary = await mkdtemp(join(tmpdir(), "session-recovery-hermes-"));
try {
  const input = join(temporary, "client.js");
  await writeFile(input, source, { mode: 0o600 });
  // Compile only. No plugin code, host operations, or model requests run here.
  execFileSync(compiler, ["-emit-binary", "-out", join(temporary, "client.hbc"), input], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  process.stdout.write(`${modules.size} client modules passed Hermes compilation.\n`);
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  else process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
