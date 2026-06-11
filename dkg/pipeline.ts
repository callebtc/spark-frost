import fs from "node:fs";
import path from "node:path";
import {
  mergeConfigOptionsForNetwork,
  normalizeNetworkType,
  SparkWallet,
} from "@buildonspark/spark-sdk";
import {
  createChillDkgSparkSigner,
  selectedSignerIndexes,
} from "./chilldkg-spark-signer.js";

type DkgDemoState = {
  network: string;
  dkgStateFile: string;
  dkgThresholdPublicKey: string;
  frostMnemonic: string;
  receiverMnemonic: string;
  frostSparkAddress: string;
  frostDepositAddress: string;
  receiverSparkAddress: string;
  faucetTxid?: string;
  transfer?: unknown;
  lightningPayment?: unknown;
};

const DEFAULT_STATE_FILE = "state/regtest-dkg-demo.json";

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

function getStatePath(): string {
  return path.resolve(
    process.cwd(),
    process.env["DKG_DEMO_STATE_FILE"] ?? DEFAULT_STATE_FILE,
  );
}

function getDkgStateFileForState(): string {
  return process.env["DKG_STATE_FILE"] ?? "state/chilldkg-2of3.json";
}

function readState(statePath: string): DkgDemoState | undefined {
  if (!fs.existsSync(statePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as DkgDemoState;
}

function writeState(statePath: string, state: DkgDemoState): void {
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

async function createState(statePath: string): Promise<DkgDemoState> {
  const { publicKey, signer } = createChillDkgSparkSigner();
  const network = normalizeNetworkType(process.env["NETWORK"], "REGTEST");
  const options = mergeConfigOptionsForNetwork(network);
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

  const state: DkgDemoState = {
    network,
    dkgStateFile: getDkgStateFileForState(),
    dkgThresholdPublicKey: Buffer.from(publicKey).toString("hex"),
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

  console.log("DKG demo state file:", statePath);
  console.log("DKG artifact file:", state.dkgStateFile);
  console.log("DKG threshold public key:", state.dkgThresholdPublicKey);
  console.log("selected DKG participants:", selectedSignerIndexes().join(","));
  console.log("frost identity mnemonic:", state.frostMnemonic);
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
      "2. Copy the faucet transaction id and rerun: FAUCET_TXID=<txid> yarn dkg:pipeline",
    );
    return;
  }

  const { signer } = createChillDkgSparkSigner();
  const network = normalizeNetworkType(process.env["NETWORK"], "REGTEST");
  const options = mergeConfigOptionsForNetwork(network);
  const { wallet: frostWallet } = await SparkWallet.initialize({
    mnemonicOrSeed: state.frostMnemonic,
    options,
    signer,
  });
  const { wallet: receiverWallet } = await SparkWallet.initialize({
    mnemonicOrSeed: state.receiverMnemonic,
    options,
  });

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
      memo: "spark-frost dkg pipeline demo",
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
  console.error("spark-frost DKG pipeline demo failed:", error);
  console.dir(error, { depth: 8 });
  process.exitCode = 1;
});
