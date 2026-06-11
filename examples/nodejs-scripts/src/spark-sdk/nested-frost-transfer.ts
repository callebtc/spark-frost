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
  const receiverAddress = process.argv[3];
  if (!receiverAddress) {
    throw new Error(
      "Usage: nested-frost-transfer <mnemonic> <receiverSparkAddress> [amountSats]",
    );
  }

  const amountSats = Number.parseInt(
    process.argv[4] ?? process.env["AMOUNT_SATS"] ?? "100",
    10,
  );
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error("amountSats must be a positive integer");
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

  const { wallet, mnemonic: walletMnemonic } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: getExampleWalletOptions(process.env, "REGTEST"),
    signer,
  });

  console.log("wallet mnemonic phrase:", walletMnemonic);
  console.log(
    `nested FROST user signing group: ${threshold}-of-${participants}; selected=${selectedParticipants.join(",")}`,
  );

  const identityPublicKey = await wallet.getIdentityPublicKey();
  console.log("identity public key:", identityPublicKey);

  const balance = await wallet.getBalance();
  console.log("balance before:", balance);

  const transfer = await wallet.transfer({
    receiverSparkAddress: receiverAddress,
    amountSats,
  });
  console.log("transfer:", transfer);

  const newBalance = await wallet.getBalance();
  console.log("balance after:", newBalance);
}

main().catch((error) => {
  console.error("Nested FROST transfer failed:", error);
  process.exitCode = 1;
});
