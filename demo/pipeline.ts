import fs from "node:fs";
import path from "node:path";
import { SparkWallet, ThresholdSparkSigner } from "@buildonspark/spark-sdk";
import { getExampleWalletOptions } from "./wallet-config.js";

type DemoState = {
  network: string;
  frostMnemonic: string;
  receiverMnemonic: string;
  frostSparkAddress: string;
  frostDepositAddress: string;
  receiverSparkAddress: string;
  faucetTxid?: string;
  transfer?: unknown;
  lightningPayment?: unknown;
};

const DEFAULT_STATE_FILE = "state/regtest-demo.json";

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

function getSelectedParticipants(): number[] {
  return (process.env["USER_FROST_SIGNERS"] ?? "1,2")
    .split(",")
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
}

function getStatePath(): string {
  return path.resolve(process.cwd(), process.env["DEMO_STATE_FILE"] ?? DEFAULT_STATE_FILE);
}

function readState(statePath: string): DemoState | undefined {
  if (!fs.existsSync(statePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as DemoState;
}

function writeState(statePath: string, state: DemoState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(
      state,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    )}\n`,
  );
}

async function createState(statePath: string): Promise<DemoState> {
  const threshold = parseIntEnv("USER_FROST_THRESHOLD", 2);
  const participants = parseIntEnv("USER_FROST_PARTICIPANTS", 3);
  const selectedParticipants = getSelectedParticipants();
  const options = getExampleWalletOptions(process.env, "REGTEST");
  const signer = new ThresholdSparkSigner({
    threshold,
    participants,
    selectedParticipants,
  });

  const { wallet: frostWallet, mnemonic: frostMnemonic } =
    await SparkWallet.initialize({
      mnemonicOrSeed: process.env["FROST_MNEMONIC"],
      options,
      signer,
    });
  const { wallet: receiverWallet, mnemonic: receiverMnemonic } =
    await SparkWallet.initialize({
      mnemonicOrSeed: process.env["RECEIVER_MNEMONIC"],
      options,
    });
  if (!frostMnemonic || !receiverMnemonic) {
    throw new Error("SparkWallet.initialize did not return both demo mnemonics");
  }

  const state: DemoState = {
    network:
      process.env["NETWORK"] ?? process.env["SPARK_NETWORK"] ?? "REGTEST",
    frostMnemonic,
    receiverMnemonic,
    frostSparkAddress: await frostWallet.getSparkAddress(),
    frostDepositAddress: await frostWallet.getSingleUseDepositAddress(),
    receiverSparkAddress: await receiverWallet.getSparkAddress(),
  };

  writeState(statePath, state);
  await frostWallet.cleanup();
  await receiverWallet.cleanup();
  return state;
}

async function main() {
  const statePath = getStatePath();
  const state = readState(statePath) ?? (await createState(statePath));
  const faucetTxid = process.argv[2] ?? process.env["FAUCET_TXID"];

  console.log("demo state file:", statePath);
  console.log("frost mnemonic:", state.frostMnemonic);
  console.log("frost spark address:", state.frostSparkAddress);
  console.log("frost bitcoin deposit address:", state.frostDepositAddress);
  console.log("normal receiver mnemonic:", state.receiverMnemonic);
  console.log("normal receiver spark address:", state.receiverSparkAddress);

  if (!faucetTxid && !state.faucetTxid) {
    console.log("");
    console.log("Next step:");
    console.log(
      "1. Open https://app.lightspark.com/regtest-faucet and fund the frost bitcoin deposit address above.",
    );
    console.log(
      "2. Copy the faucet transaction id and rerun: FAUCET_TXID=<txid> yarn demo:pipeline",
    );
    return;
  }

  const threshold = parseIntEnv("USER_FROST_THRESHOLD", 2);
  const participants = parseIntEnv("USER_FROST_PARTICIPANTS", 3);
  const selectedParticipants = getSelectedParticipants();
  const options = getExampleWalletOptions(process.env, "REGTEST");
  const signer = new ThresholdSparkSigner({
    threshold,
    participants,
    selectedParticipants,
  });
  const { wallet: frostWallet } = await SparkWallet.initialize({
    mnemonicOrSeed: state.frostMnemonic,
    options,
    signer,
  });
  const { wallet: receiverWallet } = await SparkWallet.initialize({
    mnemonicOrSeed: state.receiverMnemonic,
    options,
  });

  console.log(
    `nested FROST user signing group: ${threshold}-of-${participants}; selected=${selectedParticipants.join(",")}`,
  );
  console.log("frost balance before:", await frostWallet.getBalance());
  console.log("receiver balance before:", await receiverWallet.getBalance());

  if (!state.faucetTxid) {
    state.faucetTxid = faucetTxid;
    const leaves = await frostWallet.claimDeposit(faucetTxid);
    console.log("claimed deposit leaves:", leaves);
    writeState(statePath, state);
  } else {
    console.log("deposit already recorded:", state.faucetTxid);
  }

  console.log("frost balance after claim:", await frostWallet.getBalance());

  if (!state.transfer) {
    const amountSats = parseIntEnv("TRANSFER_AMOUNT_SATS", 1000);
    state.transfer = await frostWallet.transfer({
      receiverSparkAddress: state.receiverSparkAddress,
      amountSats,
    });
    console.log("spark transfer:", state.transfer);
    writeState(statePath, state);
  } else {
    console.log("spark transfer already recorded:", state.transfer);
  }

  console.log("frost balance after transfer:", await frostWallet.getBalance());
  console.log("receiver balance after transfer:", await receiverWallet.getBalance());

  if (!state.lightningPayment) {
    const amountSats = parseIntEnv("LIGHTNING_AMOUNT_SATS", 100);
    const maxFeeSats = parseIntEnv("MAX_FEE_SATS", 1000);
    const invoice = await receiverWallet.createLightningInvoice({
      amountSats,
      memo: "spark-frost pipeline demo",
    });
    console.log("lightning receive request:", invoice);
    state.lightningPayment = await frostWallet.payLightningInvoice({
      invoice: invoice.invoice.encodedInvoice,
      maxFeeSats,
    });
    console.log("lightning payment:", state.lightningPayment);
    writeState(statePath, state);
  } else {
    console.log("lightning payment already recorded:", state.lightningPayment);
  }

  console.log("frost balance final:", await frostWallet.getBalance());
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log("receiver balance final:", await receiverWallet.getBalance());

  await frostWallet.cleanup();
  await receiverWallet.cleanup();
}

main().catch((error) => {
  console.error("spark-frost pipeline demo failed:", error);
  process.exitCode = 1;
});
