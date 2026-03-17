import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const contractsRoot = path.resolve(currentDir, "..");
const artifactPath = path.join(
  contractsRoot,
  "artifacts",
  "contracts",
  "PrivateAgentMessaging.sol",
  "PrivateAgentMessaging.json"
);
const outputDir = path.join(contractsRoot, "abi");
const outputPath = path.join(outputDir, "PrivateAgentMessaging.json");

const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
if (!Array.isArray(artifact.abi)) {
  throw new Error(`Expected ABI array in ${artifactPath}`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact.abi, null, 2)}\n`, "utf8");

console.log(`Exported ABI to ${outputPath}`);
