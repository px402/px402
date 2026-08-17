import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import solc from "solc";

const contractNames = ["PX402BatchCommitment"];
const sources = Object.fromEntries(await Promise.all(contractNames.map(async (name) => [
  `${name}.sol`,
  { content: await readFile(resolve("contracts", `${name}.sol`), "utf8") }
])));
const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.methodIdentifiers"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors ?? [];
const fatal = errors.filter((entry) => entry.severity === "error");
for (const entry of errors) {
  const line = `${entry.severity.toUpperCase()} ${entry.formattedMessage ?? entry.message}`;
  if (entry.severity === "error") console.error(line);
  else console.warn(line);
}
if (fatal.length > 0) process.exit(1);

for (const contractName of contractNames) {
  const sourceName = `${contractName}.sol`;
  const artifact = output.contracts[sourceName][contractName];
  const outPath = resolve("build", "contracts", `${contractName}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({
    contractName,
    sourceName,
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
    methodIdentifiers: artifact.evm.methodIdentifiers
  }, null, 2));
  console.log(`CONTRACT_COMPILED ${outPath}`);
  console.log(JSON.stringify(artifact.evm.methodIdentifiers, null, 2));
}
