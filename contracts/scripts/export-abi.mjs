import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadPrivateMessagingArtifact } = require("./private-messaging-artifact.cjs");

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const contractsRoot = path.resolve(currentDir, "..");
const outputDir = path.join(contractsRoot, "abi");
const outputPath = path.join(outputDir, "PrivateMessaging.json");
const artifact = await loadPrivateMessagingArtifact();

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact.abi, null, 2)}\n`, "utf8");

console.log(`Exported ABI to ${outputPath}`);
