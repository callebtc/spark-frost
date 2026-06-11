import { SparkWallet, ThresholdSparkSigner } from "@buildonspark/spark-sdk";
import { getExampleWalletOptions } from "./wallet-config.js";

const DEFAULT_FROST_MNEMONIC =
  "april hawk one chunk produce zebra rose plunge distance welcome earth lens";
const DEFAULT_RECEIVER_MNEMONIC =
  "kidney congress outdoor ribbon detail march nature gossip identify install buzz member";

function parseIntArg(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${value} must be an integer`);
  }
  return parsed;
}

function parseIntEnv(name: string, fallback: number): number {
  return parseIntArg(process.env[name], fallback);
}

async function main() {
  const frostMnemonic = process.argv[2] ?? DEFAULT_FROST_MNEMONIC;
  const receiverMnemonic = process.argv[3] ?? DEFAULT_RECEIVER_MNEMONIC;
  const amountSats = parseIntArg(process.argv[4], 100);
  const maxFeeSats = parseIntArg(process.argv[5], 1000);

  const threshold = parseIntEnv("USER_FROST_THRESHOLD", 2);
  const participants = parseIntEnv("USER_FROST_PARTICIPANTS", 3);
  const selectedParticipants = (process.env["USER_FROST_SIGNERS"] ?? "1,2")
    .split(",")
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));

  const options = getExampleWalletOptions(process.env, "REGTEST");
  const { wallet: receiverWallet } = await SparkWallet.initialize({
    mnemonicOrSeed: receiverMnemonic,
    options,
  });

  console.log(
    "receiver spark address:",
    await receiverWallet.getSparkAddress(),
  );
  console.log("receiver balance before:", await receiverWallet.getBalance());

  const invoice = await receiverWallet.createLightningInvoice({
    amountSats,
    memo: "spark-frost lightning demo",
  });
  console.log("lightning receive request:", invoice);

  const signer = new ThresholdSparkSigner({
    threshold,
    participants,
    selectedParticipants,
  });
  const { wallet: frostWallet } = await SparkWallet.initialize({
    mnemonicOrSeed: frostMnemonic,
    options,
    signer,
  });

  console.log(
    `nested FROST user signing group: ${threshold}-of-${participants}; selected=${selectedParticipants.join(",")}`,
  );
  console.log("frost spark address:", await frostWallet.getSparkAddress());
  console.log("frost balance before:", await frostWallet.getBalance());

  const payment = await frostWallet.payLightningInvoice({
    invoice: invoice.invoice.encodedInvoice,
    maxFeeSats,
  });
  console.log("lightning payment:", payment);
  console.log("frost balance after:", await frostWallet.getBalance());

  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log("receiver balance after:", await receiverWallet.getBalance());

  await frostWallet.cleanup();
  await receiverWallet.cleanup();
}

main().catch((error) => {
  console.error("Nested FROST Lightning demo failed:", error);
  process.exitCode = 1;
});
