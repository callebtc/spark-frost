import { SparkWallet, ThresholdSparkSigner } from "@buildonspark/spark-sdk";
import {
  getExampleWalletOptions,
  requireExampleMnemonic,
} from "./wallet-config.js";

function parseIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

async function main() {
  const mnemonic = requireExampleMnemonic(process.argv[2]);
  const txid = process.argv[3];
  if (!txid) {
    throw new Error("Usage: claim-deposit <mnemonic> <txid>");
  }

  const threshold = parseIntEnv("USER_FROST_THRESHOLD", 2);
  const participants = parseIntEnv("USER_FROST_PARTICIPANTS", 3);
  const selectedParticipants = (process.env["USER_FROST_SIGNERS"] ?? "1,2")
    .split(",")
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));

  const signer = new ThresholdSparkSigner({
    threshold,
    participants,
    selectedParticipants,
  });

  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: getExampleWalletOptions(process.env, "REGTEST"),
    signer,
  });

  console.log(
    `claiming deposit with nested FROST user signing group: ${threshold}-of-${participants}; selected=${selectedParticipants.join(",")}`,
  );
  console.log("spark address:", await wallet.getSparkAddress());
  console.log("balance before:", await wallet.getBalance());

  const leaves = await wallet.claimDeposit(txid);
  console.log("claimed leaves:", leaves);
  console.log("balance after:", await wallet.getBalance());
}

main().catch((error) => {
  console.error("Nested FROST deposit claim failed:", error);
  process.exitCode = 1;
});
