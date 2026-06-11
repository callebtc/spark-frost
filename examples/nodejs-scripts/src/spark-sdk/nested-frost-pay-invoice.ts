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

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${value} must be an integer`);
  }
  return parsed;
}

async function main() {
  const mnemonic = requireExampleMnemonic(process.argv[2]);
  const invoice = process.argv[3];
  if (!invoice) {
    throw new Error(
      "Usage: nested-frost-pay-invoice <mnemonic> <bolt11Invoice> [maxFeeSats] [amountSatsToSend]",
    );
  }

  const maxFeeSats = Number.parseInt(process.argv[4] ?? "1000", 10);
  if (!Number.isInteger(maxFeeSats) || maxFeeSats < 0) {
    throw new Error("maxFeeSats must be a non-negative integer");
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
  console.log("spark address:", await wallet.getSparkAddress());
  console.log("balance before:", await wallet.getBalance());

  const payment = await wallet.payLightningInvoice({
    invoice,
    maxFeeSats,
    amountSatsToSend: parseOptionalInt(process.argv[5]),
  });
  console.log("lightning payment:", payment);
  console.log("balance after:", await wallet.getBalance());
}

main().catch((error) => {
  console.error("Nested FROST Lightning payment failed:", error);
  process.exitCode = 1;
});
