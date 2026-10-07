import { chmod, readFile, writeFile } from "node:fs/promises";

const [settingsPath, templatePath] = process.argv.slice(2);

if (!settingsPath || !templatePath) {
  throw new Error("用法：seed-claude-settings <settings-path> <template-path>");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

const template = objectValue(await readJson(templatePath, {}));
const current = objectValue(await readJson(settingsPath, {}));
const merged = {
  ...template,
  ...current,
  env: {
    ...objectValue(template.env),
    ...objectValue(current.env),
  },
};

for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
  const runtimeValue = process.env[key]?.trim();
  if (runtimeValue) merged.env[key] = runtimeValue;
}

await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
await chmod(settingsPath, 0o600);
