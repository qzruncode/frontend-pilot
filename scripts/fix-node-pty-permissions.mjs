import { chmod, readdir } from "node:fs/promises";
import path from "node:path";

const nodePtyRoot = path.resolve("node_modules/node-pty");
const helperPaths = [
  path.join(nodePtyRoot, "build/Release/spawn-helper"),
];

try {
  const prebuildRoot = path.join(nodePtyRoot, "prebuilds");
  const entries = await readdir(prebuildRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      helperPaths.push(path.join(prebuildRoot, entry.name, "spawn-helper"));
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

for (const helperPath of helperPaths) {
  try {
    await chmod(helperPath, 0o755);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}
