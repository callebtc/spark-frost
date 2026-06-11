import fs from "node:fs";
import path from "node:path";
import { mod } from "@noble/curves/abstract/modular";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  bytesToNumberBE,
  hexToBytes,
  numberToBytesBE,
} from "@noble/curves/utils";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import type { Transaction } from "@scure/btc-signer";
import {
  DefaultSparkSigner,
  getSigningCommitmentFromNonce,
  getSparkFrost,
  KeyDerivationType,
  type KeyDerivation,
  type SignFrostParams,
  type SigningCommitment,
  type SigningCommitmentWithOptionalNonce,
  type SigningNonce,
} from "@buildonspark/spark-sdk";

export type ChillDkgArtifact = {
  paramsIdHex?: string;
  threshold: number;
  participants: number;
  participantIndexBase: number;
  coordinator: {
    thresholdPubkeyHex: string;
  };
  participantsOutput: Array<{
    index: number;
    secshareHex: string;
    pubshareHexes: string[];
  }>;
};

export type ChillDkgGroupFile = {
  kind: "spark-frost-chilldkg-group";
  version: number;
  threshold: number;
  participants: number;
  participantIndexBase: number;
  paramsIdHex: string;
  coordinator: {
    thresholdPubkeyHex: string;
  };
};

export type ChillDkgKeyshareFile = {
  kind: "spark-frost-chilldkg-keyshare";
  version: number;
  threshold: number;
  participants: number;
  participantIndexBase: number;
  paramsIdHex: string;
  index: number;
  secshareHex: string;
  thresholdPubkeyHex: string;
  pubshareHexes: string[];
};

export type CoordinatorKeyFile = {
  kind: "spark-frost-coordinator-keys";
  version: number;
  identityPrivateKeyHex: string;
  depositPrivateKeyHex: string;
  staticDepositPrivateKeyHex: string;
  htlcPreimagePrivateKeyHex: string;
};

export type DkgShare = {
  index: number;
  value: bigint;
};

type ThresholdNonceState = {
  aggregateNonce: SigningNonce;
};

const ONE = numberToBytesBE(1n, 32);
const TWO = numberToBytesBE(2n, 32);

export class PublicOnlyChillDkgSparkSigner extends DefaultSparkSigner {
  private readonly identityPrivateKey?: Uint8Array;

  constructor(
    private readonly publicKey: Uint8Array,
    coordinatorKeys?: CoordinatorKeyFile,
  ) {
    super();
    this.identityPrivateKey = coordinatorKeys
      ? hexToBytes(coordinatorKeys.identityPrivateKeyHex)
      : undefined;
  }

  override createSparkWalletFromSeed(
    _seed: Uint8Array | string,
    _accountNumber?: number,
  ): Promise<string> {
    throw new Error(
      "PublicOnlyChillDkgSparkSigner uses pre-existing keys; initialize with signerWithPreExistingKeys",
    );
  }

  override generateMnemonic(): Promise<string> {
    throw new Error("PublicOnlyChillDkgSparkSigner does not generate mnemonics");
  }

  override mnemonicToSeed(_mnemonic: string): Promise<Uint8Array> {
    throw new Error("PublicOnlyChillDkgSparkSigner does not use mnemonics");
  }

  override getIdentityPublicKey(): Promise<Uint8Array> {
    if (!this.identityPrivateKey) {
      return super.getIdentityPublicKey();
    }
    return Promise.resolve(secp256k1.getPublicKey(this.identityPrivateKey));
  }

  override signMessageWithIdentityKey(
    message: Uint8Array,
    compact?: boolean,
  ): Promise<Uint8Array> {
    if (!this.identityPrivateKey) {
      return super.signMessageWithIdentityKey(message, compact);
    }
    const signature = secp256k1.sign(message, this.identityPrivateKey);
    return Promise.resolve(
      compact ? signature.toCompactRawBytes() : signature.toDERRawBytes(),
    );
  }

  override signSchnorrWithIdentityKey(message: Uint8Array): Promise<Uint8Array> {
    if (!this.identityPrivateKey) {
      return super.signSchnorrWithIdentityKey(message);
    }
    return Promise.resolve(schnorr.sign(message, this.identityPrivateKey));
  }

  override async getPublicKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    if (keyDerivation?.type === KeyDerivationType.LEAF) {
      return deriveDkgLeafPublicKey(this.publicKey, keyDerivation.path);
    }
    return super.getPublicKeyFromDerivation(keyDerivation);
  }

  override async signFrost(params: SignFrostParams): Promise<Uint8Array> {
    if (params.keyDerivation.type === KeyDerivationType.LEAF) {
      throw new Error("public-only DKG signer cannot sign Spark leaf messages");
    }
    return super.signFrost(params);
  }
}

export class ChillDkgSparkSigner extends DefaultSparkSigner {
  private readonly publicKey: Uint8Array;
  private readonly shares: DkgShare[];
  private readonly identityPrivateKey?: Uint8Array;
  private readonly depositPrivateKey?: Uint8Array;
  private readonly staticDepositPrivateKey?: Uint8Array;
  private readonly htlcPreimagePrivateKey?: Uint8Array;
  private readonly thresholdNonceStates = new Map<
    string,
    ThresholdNonceState
  >();

  constructor({
    publicKey,
    shares,
    coordinatorKeys,
  }: {
    publicKey: Uint8Array;
    shares: DkgShare[];
    coordinatorKeys?: CoordinatorKeyFile;
  }) {
    super();
    this.publicKey = publicKey;
    this.shares = shares;
    this.identityPrivateKey = coordinatorKeys
      ? hexToBytes(coordinatorKeys.identityPrivateKeyHex)
      : undefined;
    this.depositPrivateKey = coordinatorKeys
      ? hexToBytes(coordinatorKeys.depositPrivateKeyHex)
      : undefined;
    this.staticDepositPrivateKey = coordinatorKeys
      ? hexToBytes(coordinatorKeys.staticDepositPrivateKeyHex)
      : undefined;
    this.htlcPreimagePrivateKey = coordinatorKeys
      ? hexToBytes(coordinatorKeys.htlcPreimagePrivateKeyHex)
      : undefined;
  }

  override createSparkWalletFromSeed(
    _seed: Uint8Array | string,
    _accountNumber?: number,
  ): Promise<string> {
    throw new Error(
      "ChillDkgSparkSigner uses pre-existing keys; initialize with signerWithPreExistingKeys",
    );
  }

  override generateMnemonic(): Promise<string> {
    throw new Error("ChillDkgSparkSigner does not generate mnemonics");
  }

  override mnemonicToSeed(_mnemonic: string): Promise<Uint8Array> {
    throw new Error("ChillDkgSparkSigner does not use mnemonics");
  }

  override getIdentityPublicKey(): Promise<Uint8Array> {
    if (!this.identityPrivateKey) {
      return super.getIdentityPublicKey();
    }
    return Promise.resolve(secp256k1.getPublicKey(this.identityPrivateKey));
  }

  override getDepositSigningKey(): Promise<Uint8Array> {
    if (!this.depositPrivateKey) {
      return super.getDepositSigningKey();
    }
    return Promise.resolve(secp256k1.getPublicKey(this.depositPrivateKey));
  }

  override async getStaticDepositSigningKey(idx: number): Promise<Uint8Array> {
    if (!this.staticDepositPrivateKey) {
      return super.getStaticDepositSigningKey(idx);
    }
    return secp256k1.getPublicKey(this.deriveStaticDepositSecretKey(idx));
  }

  override getStaticDepositSecretKey(idx: number): Promise<Uint8Array> {
    if (!this.staticDepositPrivateKey) {
      return super.getStaticDepositSecretKey(idx);
    }
    return Promise.resolve(this.deriveStaticDepositSecretKey(idx));
  }

  override signSchnorrWithIdentityKey(message: Uint8Array): Promise<Uint8Array> {
    if (!this.identityPrivateKey) {
      return super.signSchnorrWithIdentityKey(message);
    }
    return Promise.resolve(schnorr.sign(message, this.identityPrivateKey));
  }

  override signMessageWithIdentityKey(
    message: Uint8Array,
    compact?: boolean,
  ): Promise<Uint8Array> {
    if (!this.identityPrivateKey) {
      return super.signMessageWithIdentityKey(message, compact);
    }
    const signature = secp256k1.sign(message, this.identityPrivateKey);
    return Promise.resolve(
      compact ? signature.toCompactRawBytes() : signature.toDERRawBytes(),
    );
  }

  override validateMessageWithIdentityKey(
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> {
    if (!this.identityPrivateKey) {
      return super.validateMessageWithIdentityKey(message, signature);
    }
    return Promise.resolve(
      secp256k1.verify(
        signature,
        message,
        secp256k1.getPublicKey(this.identityPrivateKey),
      ),
    );
  }

  override async decryptEcies(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this.identityPrivateKey) {
      return super.decryptEcies(ciphertext);
    }
    const privateKey = await getSparkFrost().decryptEcies(
      ciphertext,
      this.identityPrivateKey,
    );
    return secp256k1.getPublicKey(privateKey);
  }

  override signTransactionIndex(
    tx: Transaction,
    index: number,
    publicKey: Uint8Array,
  ): void {
    if (this.identityPrivateKey && sameBytes(publicKey, secp256k1.getPublicKey(this.identityPrivateKey))) {
      tx.signIdx(this.identityPrivateKey, index);
      return;
    }
    if (this.depositPrivateKey && sameBytes(publicKey, secp256k1.getPublicKey(this.depositPrivateKey))) {
      tx.signIdx(this.depositPrivateKey, index);
      return;
    }
    super.signTransactionIndex(tx, index, publicKey);
  }

  override htlcHMAC(transferID: string): Promise<Uint8Array> {
    if (!this.htlcPreimagePrivateKey) {
      return super.htlcHMAC(transferID);
    }
    return Promise.resolve(hmac(sha256, this.htlcPreimagePrivateKey, transferID));
  }

  override async getPublicKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    if (keyDerivation?.type === KeyDerivationType.LEAF) {
      return this.deriveLeafPublicKey(keyDerivation.path);
    }
    return super.getPublicKeyFromDerivation(keyDerivation);
  }

  protected override async getSigningPrivateKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    if (keyDerivation.type === KeyDerivationType.LEAF) {
      throw new Error(
        "DKG leaf private-key export is disabled; use threshold signing shares",
      );
    }
    return super.getSigningPrivateKeyFromDerivation(keyDerivation);
  }

  override getRandomSigningCommitment(): Promise<SigningCommitmentWithOptionalNonce> {
    const aggregateNonce = {
      binding: scalarToBytes(randomScalar()),
      hiding: scalarToBytes(randomScalar()),
    };
    const commitment = getSigningCommitmentFromNonce(aggregateNonce);
    this.thresholdNonceStates.set(commitmentKey(commitment), {
      aggregateNonce,
    });
    return Promise.resolve({ commitment, nonce: aggregateNonce });
  }

  override getNonceForSelfCommitment(
    selfCommitment: SigningCommitmentWithOptionalNonce,
  ): SigningNonce | undefined {
    return (
      this.thresholdNonceStates.get(commitmentKey(selfCommitment.commitment))
        ?.aggregateNonce ?? super.getNonceForSelfCommitment(selfCommitment)
    );
  }

  override async signFrost(params: SignFrostParams): Promise<Uint8Array> {
    if (params.keyDerivation.type !== KeyDerivationType.LEAF) {
      return super.signFrost(params);
    }
    const leafPublicKey = this.deriveLeafPublicKey(params.keyDerivation.path);
    const nonceState = this.thresholdNonceStates.get(
      commitmentKey(params.selfCommitment.commitment),
    );
    if (!nonceState) {
      throw new Error("missing DKG nonce for Spark signing commitment");
    }

    const baseParams = {
      message: params.message,
      nonce: nonceState.aggregateNonce,
      selfCommitment: params.selfCommitment.commitment,
      statechainCommitments: params.statechainCommitments ?? {},
      adaptorPubKey: params.adaptorPubKey,
      publicKey: leafPublicKey,
      verifyingKey: params.verifyingKey,
    };
    const sparkFrost = getSparkFrost();
    const shareForOne = await sparkFrost.signFrost({
      ...baseParams,
      keyPackage: {
        secretKey: ONE,
        publicKey: leafPublicKey,
        verifyingKey: params.verifyingKey,
      },
    });
    const shareForTwo = await sparkFrost.signFrost({
      ...baseParams,
      keyPackage: {
        secretKey: TWO,
        publicKey: leafPublicKey,
        verifyingKey: params.verifyingKey,
      },
    });

    const z1 = scalarFromBytes(shareForOne);
    const effectiveChallenge = mod(
      scalarFromBytes(shareForTwo) - z1,
      secp256k1.CURVE.n,
    );
    const nonceOnlyShare = mod(z1 - effectiveChallenge, secp256k1.CURVE.n);
    const selectedIndexes = this.shares.map((share) => BigInt(share.index));
    const participantSignatureContribution = this.shares.reduce(
      (sum, share) => {
        const lambda = lagrangeCoefficientAtZero(
          BigInt(share.index),
          selectedIndexes,
        );
        const partial = mod(
          effectiveChallenge * lambda * share.value,
          secp256k1.CURVE.n,
        );
        return mod(sum + partial, secp256k1.CURVE.n);
      },
      0n,
    );
    const tweakSignatureContribution = mod(
      effectiveChallenge * this.leafTweak(params.keyDerivation.path),
      secp256k1.CURVE.n,
    );
    return scalarToBytes(
      nonceOnlyShare +
        participantSignatureContribution +
        tweakSignatureContribution,
    );
  }

  getSharesForDebug(): DkgShare[] {
    return this.shares;
  }

  private deriveLeafPublicKey(path: string): Uint8Array {
    return deriveDkgLeafPublicKey(this.publicKey, path, this.leafTweak(path));
  }

  private leafTweak(path: string): bigint {
    return dkgLeafTweak(path);
  }

  private deriveStaticDepositSecretKey(idx: number): Uint8Array {
    if (!this.staticDepositPrivateKey) {
      throw new Error("Static deposit key not initialized");
    }
    return scalarToBytes(
      mod(
        bytesToNumberBE(
          sha256(
            concatBytes(
              new TextEncoder().encode("spark-frost-static-deposit"),
              this.staticDepositPrivateKey,
              numberToBytesBE(BigInt(idx), 32),
            ),
          ),
        ),
        secp256k1.CURVE.n,
      ),
    );
  }
}

export function loadArtifact(
  artifactPath = process.env["DKG_STATE_FILE"] ?? "state/chilldkg-2of3.json",
): ChillDkgArtifact {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), artifactPath), "utf8"),
  ) as ChillDkgArtifact;
}

export function loadGroupFile(groupPath: string): ChillDkgGroupFile {
  const group = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), groupPath), "utf8"),
  ) as ChillDkgGroupFile;
  if (group.kind !== "spark-frost-chilldkg-group") {
    throw new Error(`Not a spark-frost DKG group file: ${groupPath}`);
  }
  return group;
}

export function loadKeyshareFile(sharePath: string): ChillDkgKeyshareFile {
  const share = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), sharePath), "utf8"),
  ) as ChillDkgKeyshareFile;
  if (share.kind !== "spark-frost-chilldkg-keyshare") {
    throw new Error(`Not a spark-frost DKG keyshare file: ${sharePath}`);
  }
  return share;
}

export function loadCoordinatorKeyFile(
  coordinatorKeyPath: string,
): CoordinatorKeyFile {
  const keys = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), coordinatorKeyPath), "utf8"),
  ) as CoordinatorKeyFile;
  if (keys.kind !== "spark-frost-coordinator-keys") {
    throw new Error(
      `Not a spark-frost coordinator key file: ${coordinatorKeyPath}`,
    );
  }
  return keys;
}

export function artifactFromSplitFiles(
  groupPath: string,
  sharePaths: string[],
): ChillDkgArtifact {
  const group = loadGroupFile(groupPath);
  const shares = sharePaths.map((sharePath) => loadKeyshareFile(sharePath));
  for (const share of shares) {
    if (share.paramsIdHex !== group.paramsIdHex) {
      throw new Error(
        `Keyshare ${share.index} belongs to another DKG session`,
      );
    }
    if (share.thresholdPubkeyHex !== group.coordinator.thresholdPubkeyHex) {
      throw new Error(
        `Keyshare ${share.index} has a different threshold public key`,
      );
    }
    if (
      share.threshold !== group.threshold ||
      share.participants !== group.participants ||
      share.participantIndexBase !== group.participantIndexBase
    ) {
      throw new Error(`Keyshare ${share.index} has mismatched DKG parameters`);
    }
  }
  return {
    paramsIdHex: group.paramsIdHex,
    threshold: group.threshold,
    participants: group.participants,
    participantIndexBase: group.participantIndexBase,
    coordinator: group.coordinator,
    participantsOutput: shares.map((share) => ({
      index: share.index,
      secshareHex: share.secshareHex,
      pubshareHexes: share.pubshareHexes,
    })),
  };
}

export function publicKeyFromGroupFile(groupPath: string): Uint8Array {
  return normalizeSparkPublicKey(
    hexToBytes(loadGroupFile(groupPath).coordinator.thresholdPubkeyHex),
  );
}

export function createPublicOnlyChillDkgSparkSigner(
  groupPath: string,
  coordinatorKeyPath?: string,
): PublicOnlyChillDkgSparkSigner {
  return new PublicOnlyChillDkgSparkSigner(
    publicKeyFromGroupFile(groupPath),
    coordinatorKeyPath ? loadCoordinatorKeyFile(coordinatorKeyPath) : undefined,
  );
}

export function createChillDkgSparkSignerFromShareFiles(
  groupPath: string,
  sharePaths: string[],
  options: {
    coordinatorKeyPath?: string;
    coordinatorKeys?: CoordinatorKeyFile;
  } = {},
): ReturnType<typeof createChillDkgSparkSigner> {
  const artifact = artifactFromSplitFiles(groupPath, sharePaths);
  return createChillDkgSparkSigner(
    artifact,
    artifact.participantsOutput.map((participant) => participant.index),
    options,
  );
}

export function createChillDkgSparkSigner(
  artifact = loadArtifact(),
  selected = selectedSignerIndexes(),
  options: {
    coordinatorKeyPath?: string;
    coordinatorKeys?: CoordinatorKeyFile;
  } = {},
): {
  artifact: ChillDkgArtifact;
  publicKey: Uint8Array;
  negateShares: boolean;
  signer: ChillDkgSparkSigner;
  shares: DkgShare[];
} {
  if (artifact.participantIndexBase !== 1) {
    throw new Error("Expected one-based DKG participant indexes");
  }
  if (selected.length !== artifact.threshold) {
    throw new Error(
      `Need exactly ${artifact.threshold} selected signers, got ${selected.length}`,
    );
  }

  const publicKey = hexToBytes(artifact.coordinator.thresholdPubkeyHex);
  const negateShares = publicKey[0] === 3;
  if (negateShares) {
    publicKey[0] = 2;
  }
  const shares = selectedShares(artifact, selected, negateShares);
  const coordinatorKeys =
    options.coordinatorKeys ??
    (options.coordinatorKeyPath
      ? loadCoordinatorKeyFile(options.coordinatorKeyPath)
      : undefined);
  return {
    artifact,
    publicKey,
    negateShares,
    shares,
    signer: new ChillDkgSparkSigner({
      publicKey,
      shares,
      coordinatorKeys,
    }),
  };
}

export function scalarToBytes(value: bigint): Uint8Array {
  return numberToBytesBE(mod(value, secp256k1.CURVE.n), 32);
}

export function scalarFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error(`Expected 32-byte scalar, got ${bytes.length}`);
  }
  return bytesToNumberBE(bytes);
}

export function selectedSignerIndexes(): number[] {
  return (process.env["USER_FROST_SIGNERS"] ?? "1,2")
    .split(",")
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
}

export function normalizeSparkPublicKey(publicKey: Uint8Array): Uint8Array {
  const normalized = new Uint8Array(publicKey);
  if (normalized[0] === 3) {
    normalized[0] = 2;
  }
  return normalized;
}

export function deriveDkgLeafPublicKey(
  basePublicKey: Uint8Array,
  path: string,
  tweak = dkgLeafTweak(path),
): Uint8Array {
  if (tweak === 0n) {
    return new Uint8Array(basePublicKey);
  }
  return secp256k1.Point.fromHex(basePublicKey)
    .add(secp256k1.Point.BASE.multiply(tweak))
    .toBytes(true);
}

export function dkgLeafTweak(path: string): bigint {
  return mod(
    bytesToNumberBE(sha256(`spark-frost-dkg-leaf:${path}`)),
    secp256k1.CURVE.n,
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
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

function selectedShares(
  artifact: ChillDkgArtifact,
  selected: number[],
  negateShares: boolean,
): DkgShare[] {
  return selected.map((index) => {
    const output = artifact.participantsOutput.find(
      (participant) => participant.index === index,
    );
    if (!output?.secshareHex) {
      throw new Error(`Missing DKG secret share for participant ${index}`);
    }
    const expectedPubshare = output.pubshareHexes[index - 1];
    const rawShare = bytesToNumberBE(hexToBytes(output.secshareHex));
    const actualPubshare = secp256k1.Point.BASE.multiply(rawShare).toHex(true);
    if (expectedPubshare && actualPubshare !== expectedPubshare) {
      throw new Error(`Participant ${index} DKG share failed public check`);
    }
    return {
      index,
      value: negateShares ? mod(-rawShare, secp256k1.CURVE.n) : rawShare,
    };
  });
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

function invertScalar(value: bigint): bigint {
  if (value === 0n) {
    throw new Error("Cannot invert zero scalar");
  }
  return modPow(value, secp256k1.CURVE.n - 2n, secp256k1.CURVE.n);
}

function randomScalar(): bigint {
  return scalarFromBytes(secp256k1.utils.randomPrivateKey());
}

function commitmentKey(commitment: SigningCommitment): string {
  return `${bytesToHex(commitment.hiding)}:${bytesToHex(commitment.binding)}`;
}
