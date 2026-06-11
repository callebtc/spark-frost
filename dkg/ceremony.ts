import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mod } from "@noble/curves/abstract/modular";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  bytesToNumberBE,
  hexToBytes,
  numberToBytesBE,
} from "@noble/curves/utils";
import { sha256 } from "@noble/hashes/sha2";
import {
  mergeConfigOptionsForNetwork,
  normalizeNetworkType,
  SparkWallet,
  type NetworkType,
} from "@buildonspark/spark-sdk";
import {
  createChillDkgSparkSignerFromShareFiles,
  createPublicOnlyChillDkgSparkSigner,
  loadGroupFile,
  loadKeyshareFile,
  normalizeSparkPublicKey,
} from "./chilldkg-spark-signer.js";

type ProposalKind = "transfer" | "lightning";

type SigningParticipant = {
  index: number;
  shareFile: string;
  nonceCommitmentHex: string;
  nonceSecretHex: string;
  signatureShareHex?: string;
};

type CeremonyProposal = {
  kind: "spark-frost-ceremony-proposal";
  version: 1;
  network: NetworkType;
  groupFile: string;
  threshold: number;
  participants: number;
  dkgThresholdPublicKey: string;
  frostMnemonic: string;
  frostSparkAddress: string;
  frostDepositAddress: string;
  receiverMnemonic?: string;
  receiverSparkAddress?: string;
  payment: {
    kind: ProposalKind;
    amountSats: number;
    maxFeeSats?: number;
    lightningInvoice?: string;
  };
  proposalHashHex: string;
  signing: {
    status: "collecting" | "aggregated";
    signers: SigningParticipant[];
    aggregateNonceHex?: string;
    aggregateSignatureHex?: string;
  };
  execution?: {
    faucetTxid?: string;
    claim?: unknown;
    result?: unknown;
  };
};

type CliArgs = {
  positional: string[];
  options: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      options[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[name] = next;
      i += 1;
    } else {
      options[name] = true;
    }
  }
  return { positional, options };
}

function stringOption(
  args: CliArgs,
  name: string,
  fallback?: string,
): string | undefined {
  const value = args.options[name];
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function numberOption(args: CliArgs, name: string, fallback: number): number {
  const value = stringOption(args, name);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`--${name} must be an integer`);
  }
  return parsed;
}

function boolOption(args: CliArgs, name: string): boolean {
  return args.options[name] === true || args.options[name] === "true";
}

function resolveDkgPath(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}

function relativeDkgPath(filePath: string): string {
  return path.relative(process.cwd(), resolveDkgPath(filePath));
}

function writeJson(filePath: string, value: unknown): void {
  const resolved = resolveDkgPath(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readProposal(filePath: string): CeremonyProposal {
  return JSON.parse(
    fs.readFileSync(resolveDkgPath(filePath), "utf8"),
  ) as CeremonyProposal;
}

function defaultOutputDir(threshold: number, participants: number): string {
  return `output/${threshold}-of-${participants}`;
}

function defaultProposalPath(groupFile: string): string {
  return path.join(path.dirname(groupFile), "proposal.json");
}

function proposalPayload(proposal: Omit<CeremonyProposal, "proposalHashHex">) {
  return {
    network: proposal.network,
    groupFile: proposal.groupFile,
    threshold: proposal.threshold,
    participants: proposal.participants,
    dkgThresholdPublicKey: proposal.dkgThresholdPublicKey,
    frostSparkAddress: proposal.frostSparkAddress,
    frostDepositAddress: proposal.frostDepositAddress,
    receiverSparkAddress: proposal.receiverSparkAddress,
    payment: proposal.payment,
  };
}

function hashProposal(proposal: Omit<CeremonyProposal, "proposalHashHex">) {
  return bytesToHex(sha256(JSON.stringify(proposalPayload(proposal))));
}

function runKeygen(args: CliArgs): string {
  const threshold = numberOption(args, "threshold", 2);
  const participants = numberOption(args, "participants", 3);
  const out = stringOption(args, "out", defaultOutputDir(threshold, participants))!;
  const artifact = path.join(out, "artifact.json");
  console.log("");
  console.log(`Stage 1: simulating ChillDKG for a ${threshold}-of-${participants} wallet`);
  console.log("Each participant receives a separate keyshare text file.");
  const result = spawnSync(
    process.execPath,
    [
      "run-python.mjs",
      "chilldkg_keygen.py",
      "--threshold",
      String(threshold),
      "--participants",
      String(participants),
      "--output",
      artifact,
      "--output-dir",
      out,
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    throw new Error("ChillDKG key generation failed");
  }
  console.log("");
  console.log(`Group file: ${path.join(out, "group.txt")}`);
  for (let i = 1; i <= participants; i += 1) {
    console.log(`Participant ${i}: ${path.join(out, `participant-${i}-share.txt`)}`);
  }
  return out;
}

async function runPropose(args: CliArgs): Promise<string> {
  const groupFile = stringOption(args, "group");
  if (!groupFile) {
    throw new Error("propose requires --group <group.txt>");
  }
  const proposalFile = stringOption(
    args,
    "proposal",
    defaultProposalPath(groupFile),
  )!;
  const kind = stringOption(args, "kind", "transfer") as ProposalKind;
  if (kind !== "transfer" && kind !== "lightning") {
    throw new Error("--kind must be transfer or lightning");
  }
  const amountSats = numberOption(args, "amount", kind === "transfer" ? 1000 : 100);
  const maxFeeSats = numberOption(args, "max-fee", 1000);
  const network = normalizeNetworkType(
    stringOption(args, "network", process.env["NETWORK"]),
    "REGTEST",
  );
  const group = loadGroupFile(groupFile);
  const publicKey = normalizeSparkPublicKey(
    hexToBytes(group.coordinator.thresholdPubkeyHex),
  );

  console.log("");
  console.log("Stage 2a: coordinator proposes a Spark action");
  console.log("The coordinator only needs the public group file here.");
  const options = mergeConfigOptionsForNetwork(network);
  const { wallet: frostWallet, mnemonic: frostMnemonic } =
    await SparkWallet.initialize({
      mnemonicOrSeed: stringOption(args, "frost-mnemonic"),
      options,
      signer: createPublicOnlyChillDkgSparkSigner(groupFile),
    });
  if (!frostMnemonic) {
    throw new Error("SparkWallet.initialize did not return a FROST wallet mnemonic");
  }
  const frostSparkAddress = await frostWallet.getSparkAddress();
  const frostDepositAddress = await frostWallet.getSingleUseDepositAddress();

  let receiverMnemonic = stringOption(args, "receiver-mnemonic");
  let receiverSparkAddress = stringOption(args, "receiver-spark-address");
  let lightningInvoice: string | undefined;
  let receiverWallet: SparkWallet | undefined;
  if (!receiverSparkAddress || kind === "lightning") {
    const receiver = await SparkWallet.initialize({
      mnemonicOrSeed: receiverMnemonic,
      options,
    });
    receiverWallet = receiver.wallet;
    receiverMnemonic = receiver.mnemonic;
    receiverSparkAddress = await receiver.wallet.getSparkAddress();
  }
  if (kind === "lightning") {
    if (!receiverWallet) {
      throw new Error("Lightning proposal requires a receiver wallet");
    }
    const invoice = await receiverWallet.createLightningInvoice({
      amountSats,
      memo: "spark-frost staged DKG ceremony",
    });
    lightningInvoice = invoice.invoice.encodedInvoice;
  }

  const baseProposal: Omit<CeremonyProposal, "proposalHashHex"> = {
    kind: "spark-frost-ceremony-proposal",
    version: 1,
    network,
    groupFile: relativeDkgPath(groupFile),
    threshold: group.threshold,
    participants: group.participants,
    dkgThresholdPublicKey: bytesToHex(publicKey),
    frostMnemonic,
    frostSparkAddress,
    frostDepositAddress,
    receiverMnemonic,
    receiverSparkAddress,
    payment: {
      kind,
      amountSats,
      maxFeeSats: kind === "lightning" ? maxFeeSats : undefined,
      lightningInvoice,
    },
    signing: {
      status: "collecting",
      signers: [],
    },
  };
  const proposal: CeremonyProposal = {
    ...baseProposal,
    proposalHashHex: hashProposal(baseProposal),
  };
  writeJson(proposalFile, proposal);

  await frostWallet.cleanup();
  await receiverWallet?.cleanup();

  console.log(`Proposal file: ${proposalFile}`);
  console.log(`FROST Spark address: ${frostSparkAddress}`);
  console.log(`Fund this REGTEST Bitcoin deposit address: ${frostDepositAddress}`);
  console.log(`Receiver Spark address: ${receiverSparkAddress}`);
  if (lightningInvoice) {
    console.log(`Lightning invoice prepared for ${amountSats} sats.`);
  }
  return proposalFile;
}

function runSign(args: CliArgs): string {
  const proposalFile = stringOption(args, "proposal");
  const shareFile = stringOption(args, "share");
  if (!proposalFile || !shareFile) {
    throw new Error("sign requires --proposal <proposal.json> --share <participant-share.txt>");
  }
  const proposal = readProposal(proposalFile);
  if (proposal.signing.status === "aggregated") {
    console.log("Proposal already has an aggregate authorization signature.");
    return proposalFile;
  }
  const share = loadKeyshareFile(shareFile);
  if (share.paramsIdHex !== loadGroupFile(proposal.groupFile).paramsIdHex) {
    throw new Error(`Participant ${share.index} belongs to another DKG session`);
  }
  if (proposal.signing.signers.some((signer) => signer.index === share.index)) {
    throw new Error(`Participant ${share.index} already signed this proposal`);
  }
  if (proposal.signing.signers.length >= proposal.threshold) {
    throw new Error(`This demo already collected ${proposal.threshold} signers`);
  }

  const nonce = randomScalar();
  const nonceCommitment = secp256k1.Point.BASE.multiply(nonce).toHex(true);
  proposal.signing.signers.push({
    index: share.index,
    shareFile: relativeDkgPath(shareFile),
    nonceCommitmentHex: nonceCommitment,
    nonceSecretHex: bytesToHex(scalarToBytes(nonce)),
  });

  console.log("");
  console.log(`Stage 2b: participant ${share.index} adds a signature share`);
  console.log(`Collected ${proposal.signing.signers.length}/${proposal.threshold} required shares.`);
  if (proposal.signing.signers.length === proposal.threshold) {
    aggregateAuthorizationSignature(proposal);
    console.log("Threshold reached. Coordinator aggregated the authorization signature.");
  } else {
    console.log("More participants still need to sign before execution is allowed.");
  }
  writeJson(proposalFile, proposal);
  return proposalFile;
}

async function runExecute(args: CliArgs): Promise<string> {
  const proposalFile = stringOption(args, "proposal");
  if (!proposalFile) {
    throw new Error("execute requires --proposal <proposal.json>");
  }
  const proposal = readProposal(proposalFile);
  if (proposal.signing.status !== "aggregated") {
    throw new Error("Proposal has not reached the threshold signing stage yet");
  }
  const faucetTxid = stringOption(args, "faucet-txid", proposal.execution?.faucetTxid);
  if (!faucetTxid && !proposal.execution?.claim) {
    console.log("");
    console.log("Stage 3: ready to execute, but the wallet must be funded first.");
    console.log(`Fund this REGTEST Bitcoin deposit address: ${proposal.frostDepositAddress}`);
    console.log(
      `Then run: NETWORK=${proposal.network} yarn dkg:ceremony execute --proposal ${proposalFile} --faucet-txid <txid>`,
    );
    return proposalFile;
  }

  console.log("");
  console.log("Stage 3: executing with the collected threshold keyshares");
  const shareFiles = proposal.signing.signers.map((signer) => signer.shareFile);
  const { signer } = createChillDkgSparkSignerFromShareFiles(
    proposal.groupFile,
    shareFiles,
  );
  const options = mergeConfigOptionsForNetwork(proposal.network);
  const { wallet: frostWallet } = await SparkWallet.initialize({
    mnemonicOrSeed: proposal.frostMnemonic,
    options,
    signer,
  });
  const receiver = proposal.receiverMnemonic
    ? await SparkWallet.initialize({
        mnemonicOrSeed: proposal.receiverMnemonic,
        options,
      })
    : undefined;

  proposal.execution ??= {};
  if (!proposal.execution.claim && faucetTxid) {
    proposal.execution.faucetTxid = faucetTxid;
    proposal.execution.claim = await frostWallet.claimDeposit(faucetTxid);
    writeJson(proposalFile, proposal);
    console.log("Deposit claimed into the DKG-controlled Spark wallet.");
  } else {
    console.log("Deposit claim already recorded.");
  }

  if (!proposal.execution.result) {
    if (proposal.payment.kind === "transfer") {
      proposal.execution.result = await frostWallet.transfer({
        receiverSparkAddress: proposal.receiverSparkAddress!,
        amountSats: proposal.payment.amountSats,
      });
      console.log(`Spark transfer sent for ${proposal.payment.amountSats} sats.`);
    } else {
      proposal.execution.result = await frostWallet.payLightningInvoice({
        invoice: proposal.payment.lightningInvoice!,
        maxFeeSats: proposal.payment.maxFeeSats ?? 1000,
      });
      console.log(`Lightning payment sent for ${proposal.payment.amountSats} sats.`);
    }
    writeJson(proposalFile, proposal);
  } else {
    console.log("Execution result already recorded.");
  }

  console.log("FROST wallet balance:", await frostWallet.getBalance());
  if (receiver) {
    console.log("Receiver wallet balance:", await receiver.wallet.getBalance());
  }
  await frostWallet.cleanup();
  await receiver?.wallet.cleanup();
  return proposalFile;
}

async function runWalkthrough(args: CliArgs) {
  console.log("");
  console.log("spark-frost staged DKG walkthrough");
  console.log("This will generate keyshare files, create a proposal, collect threshold signers, then execute if a faucet txid is supplied.");
  const threshold = numberOption(args, "threshold", 2);
  const participants = numberOption(args, "participants", 3);
  const out = stringOption(args, "out", defaultOutputDir(threshold, participants))!;
  const yes = boolOption(args, "yes");
  runKeygen({
    positional: [],
    options: { threshold: String(threshold), participants: String(participants), out },
  });
  const groupFile = path.join(out, "group.txt");
  const proposalFile = await runPropose({
    positional: [],
    options: {
      group: groupFile,
      proposal: path.join(out, "proposal.json"),
      kind: stringOption(args, "kind", "transfer")!,
      amount: String(numberOption(args, "amount", 1000)),
      "max-fee": String(numberOption(args, "max-fee", 1000)),
      network: stringOption(args, "network", process.env["NETWORK"] ?? "REGTEST")!,
    },
  });
  for (let i = 1; i <= threshold; i += 1) {
    if (!yes) {
      console.log("");
      console.log(`Press enter when participant ${i} is ready to contribute their share.`);
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    }
    runSign({
      positional: [],
      options: {
        proposal: proposalFile,
        share: path.join(out, `participant-${i}-share.txt`),
      },
    });
  }
  await runExecute({
    positional: [],
    options: {
      proposal: proposalFile,
      "faucet-txid": stringOption(args, "faucet-txid") ?? false,
    },
  });
}

function aggregateAuthorizationSignature(proposal: CeremonyProposal) {
  const group = loadGroupFile(proposal.groupFile);
  const rawPublicKey = hexToBytes(group.coordinator.thresholdPubkeyHex);
  const negateShares = rawPublicKey[0] === 3;
  const publicKey = normalizeSparkPublicKey(rawPublicKey);
  const signerIndexes = proposal.signing.signers.map((signer) =>
    BigInt(signer.index),
  );
  const aggregateNoncePoint = proposal.signing.signers
    .map((signer) => secp256k1.Point.fromHex(signer.nonceCommitmentHex))
    .reduce((sum, point) => (sum ? sum.add(point) : point));
  const aggregateNonceHex = aggregateNoncePoint.toHex(true);
  const challenge = challengeScalar(
    hexToBytes(aggregateNonceHex),
    publicKey,
    hexToBytes(proposal.proposalHashHex),
  );
  let aggregateZ = 0n;
  for (const signer of proposal.signing.signers) {
    const shareFile = loadKeyshareFile(signer.shareFile);
    let shareValue = bytesToNumberBE(hexToBytes(shareFile.secshareHex));
    if (negateShares) {
      shareValue = mod(-shareValue, secp256k1.CURVE.n);
    }
    const lambda = lagrangeCoefficientAtZero(BigInt(signer.index), signerIndexes);
    const nonce = bytesToNumberBE(hexToBytes(signer.nonceSecretHex));
    const signatureShare = mod(
      nonce + challenge * lambda * shareValue,
      secp256k1.CURVE.n,
    );
    signer.signatureShareHex = bytesToHex(scalarToBytes(signatureShare));
    aggregateZ = mod(aggregateZ + signatureShare, secp256k1.CURVE.n);
  }

  const left = secp256k1.Point.BASE.multiply(aggregateZ);
  const right = aggregateNoncePoint.add(
    secp256k1.Point.fromHex(bytesToHex(publicKey)).multiply(challenge),
  );
  if (left.toHex(true) !== right.toHex(true)) {
    throw new Error("Aggregated authorization signature did not verify");
  }
  proposal.signing.status = "aggregated";
  proposal.signing.aggregateNonceHex = aggregateNonceHex;
  proposal.signing.aggregateSignatureHex = `${aggregateNonceHex}:${bytesToHex(
    scalarToBytes(aggregateZ),
  )}`;
}

function challengeScalar(
  aggregateNonce: Uint8Array,
  publicKey: Uint8Array,
  proposalHash: Uint8Array,
): bigint {
  return mod(
    bytesToNumberBE(sha256(concatBytes(aggregateNonce, publicKey, proposalHash))),
    secp256k1.CURVE.n,
  );
}

function lagrangeCoefficientAtZero(x: bigint, xs: bigint[]): bigint {
  return xs
    .filter((candidate) => candidate !== x)
    .reduce((acc, other) => {
      const numerator = mod(-other, secp256k1.CURVE.n);
      const denominator = mod(x - other, secp256k1.CURVE.n);
      return mod(
        acc * numerator * invertScalar(denominator),
        secp256k1.CURVE.n,
      );
    }, 1n);
}

function invertScalar(value: bigint): bigint {
  if (value === 0n) {
    throw new Error("Cannot invert zero scalar");
  }
  return modPow(value, secp256k1.CURVE.n - 2n, secp256k1.CURVE.n);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = mod(result * b, modulus);
    }
    b = mod(b * b, modulus);
    e >>= 1n;
  }
  return result;
}

function randomScalar(): bigint {
  return bytesToNumberBE(secp256k1.utils.randomPrivateKey());
}

function scalarToBytes(value: bigint): Uint8Array {
  return numberToBytesBE(mod(value, secp256k1.CURVE.n), 32);
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const length = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function usage() {
  console.log(`spark-frost DKG ceremony

Commands:
  keygen      --threshold 3 --participants 5 --out output/3-of-5
  propose     --group output/3-of-5/group.txt --kind transfer --amount 1000
  sign        --proposal output/3-of-5/proposal.json --share output/3-of-5/participant-1-share.txt
  execute     --proposal output/3-of-5/proposal.json --faucet-txid <txid>
  walkthrough --threshold 2 --participants 3 --out output/walkthrough --yes

Payment kinds:
  transfer    Creates or uses a normal Spark receiver address.
  lightning   Creates a receiver Lightning invoice and pays it at execution.
`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case "keygen":
      runKeygen(args);
      break;
    case "propose":
      await runPropose(args);
      break;
    case "sign":
      runSign(args);
      break;
    case "execute":
      await runExecute(args);
      break;
    case "walkthrough":
      await runWalkthrough(args);
      break;
    default:
      usage();
      if (command) {
        process.exitCode = 1;
      }
  }
}

main().catch((error) => {
  console.error("spark-frost ceremony failed:", error);
  console.dir(error, { depth: 8 });
  process.exitCode = 1;
});
