import { SparkWallet, ThresholdSparkSigner } from "@buildonspark/spark-sdk";
import {
  getExampleWalletOptions,
  getExampleMnemonic,
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

  const { wallet, mnemonic } = await SparkWallet.initialize({
    mnemonicOrSeed: getExampleMnemonic(process.argv[2]),
    options: getExampleWalletOptions(process.env, "REGTEST"),
    signer,
  });

  console.log("wallet mnemonic phrase:", mnemonic);
  console.log(
    `nested FROST user signing group: ${threshold}-of-${participants}; selected=${selectedParticipants.join(",")}`,
  );
  console.log("identity public key:", await wallet.getIdentityPublicKey());
  console.log("spark address:", await wallet.getSparkAddress());
  console.log(
    "single-use regtest bitcoin deposit address:",
    await wallet.getSingleUseDepositAddress(),
  );
  console.log("balance:", await wallet.getBalance());
}

main().catch((error) => {
  console.error("Nested FROST wallet creation failed:", error);
  process.exitCode = 1;
});
