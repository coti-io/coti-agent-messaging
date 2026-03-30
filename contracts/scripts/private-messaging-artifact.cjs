const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const solc = require("solc");

const requireFromHere = createRequire(__filename);
const contractsPackageRoot = path.dirname(
  requireFromHere.resolve("@coti-io/coti-contracts/package.json")
);
const PRIVATE_MESSAGING_SOURCE = "contracts/messaging/PrivateMessaging.sol";
const PRIVATE_MESSAGING_CONTRACT = "PrivateMessaging";

const IMPORT_RE = /^\s*import\s+(?:[^"'\\]+from\s+)?["']([^"']+)["'];/gm;

function resolveSource(importer, specifier) {
  if (specifier.startsWith(".")) {
    const importerDir = path.posix.dirname(importer);
    const sourceName = path.posix.normalize(path.posix.join(importerDir, specifier));
    return {
      sourceName,
      filePath: path.join(contractsPackageRoot, ...sourceName.split("/"))
    };
  }

  return {
    sourceName: specifier,
    filePath: requireFromHere.resolve(specifier, { paths: [contractsPackageRoot] })
  };
}

async function collectSources(sourceName, filePath, sources, visited) {
  if (visited.has(sourceName)) {
    return;
  }

  visited.add(sourceName);

  const content = await readFile(filePath, "utf8");
  sources[sourceName] = { content };

  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    const resolved = resolveSource(sourceName, specifier);
    await collectSources(resolved.sourceName, resolved.filePath, sources, visited);
  }
}

async function loadPrivateMessagingArtifact() {
  const sources = {};
  await collectSources(
    PRIVATE_MESSAGING_SOURCE,
    path.join(contractsPackageRoot, ...PRIVATE_MESSAGING_SOURCE.split("/")),
    sources,
    new Set()
  );

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 10000
      },
      evmVersion: "paris",
      metadata: {
        bytecodeHash: "none"
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"]
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = Array.isArray(output.errors) ? output.errors : [];
  const fatalErrors = errors.filter((error) => error.severity === "error");

  if (fatalErrors.length > 0) {
    throw new Error(
      `Solidity compilation failed:\n${fatalErrors.map((error) => error.formattedMessage).join("\n")}`
    );
  }

  const contractOutput = output.contracts?.[PRIVATE_MESSAGING_SOURCE]?.[PRIVATE_MESSAGING_CONTRACT];
  if (!contractOutput) {
    throw new Error("Compiled output did not include PrivateMessaging.");
  }

  const bytecode = contractOutput.evm?.bytecode?.object;
  if (typeof bytecode !== "string" || bytecode.length === 0) {
    throw new Error("Compiled PrivateMessaging bytecode was empty.");
  }

  return {
    abi: contractOutput.abi,
    bytecode: `0x${bytecode}`
  };
}

module.exports = {
  loadPrivateMessagingArtifact
};
