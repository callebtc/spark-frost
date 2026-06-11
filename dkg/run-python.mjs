import { spawnSync } from "node:child_process";

const requested = process.env.PYTHON;
const candidates = requested
  ? [requested]
  : ["python3.12", "python3.11", "python3"];

let selected;
for (const candidate of candidates) {
  const version = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
  });
  if (version.status === 0) {
    selected = candidate;
    break;
  }
}

if (!selected) {
  console.error("Could not find Python. Install Python 3.11+ or set PYTHON.");
  process.exit(1);
}

const check = spawnSync(
  selected,
  [
    "-c",
    "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)",
  ],
  { encoding: "utf8" },
);
if (check.status !== 0) {
  console.error(
    `Python 3.11+ is required for Blockstream's ChillDKG reference. Selected: ${selected}`,
  );
  console.error("Set PYTHON=/path/to/python3.11-or-newer and retry.");
  process.exit(1);
}

const result = spawnSync(selected, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
