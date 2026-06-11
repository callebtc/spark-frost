import fs from "node:fs";
import path from "node:path";
import { mod } from "@noble/curves/abstract/modular";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  bytesToNumberBE,
  hexToBytes,
  numberToBytesBE,
} from "@noble/curves/utils";
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
  constructor(private readonly publicKey: Uint8Array) {
    super();
  }

  override async getPublicKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    if (keyDerivation?.type === KeyDerivationType.LEAF) {
      return this.publicKey;
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
  private readonly thresholdNonceStates = new Map<
    string,
    ThresholdNonceState
  >();

  constructor({
    publicKey,
    shares,
  }: {
    publicKey: Uint8Array;
    shares: DkgShare[];
  }) {
    super();
    this.publicKey = publicKey;
    this.shares = shares;
  }

  override async getPublicKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    if (keyDerivation?.type === KeyDerivationType.LEAF) {
      return this.publicKey;
    }
    return super.getPublicKeyFromDerivation(keyDerivation);
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
    const nonceState = this.thresholdNonceStates.get(
      commitmentKey(params.selfCommitment.commitment),
    );
    if (!nonceState) {
      throw new Error("missing DKG nonce for Spark signing commitment");
    }

    const selectedIndexes = this.shares.map((share) => BigInt(share.index));
    const thresholdSecretContribution = this.shares.reduce((sum, share) => {
      const lambda = lagrangeCoefficientAtZero(
        BigInt(share.index),
        selectedIndexes,
      );
      return mod(sum + lambda * share.value, secp256k1.CURVE.n);
    }, 0n);

    const baseParams = {
      message: params.message,
      nonce: nonceState.aggregateNonce,
      selfCommitment: params.selfCommitment.commitment,
      statechainCommitments: params.statechainCommitments ?? {},
      adaptorPubKey: params.adaptorPubKey,
      publicKey: this.publicKey,
      verifyingKey: params.verifyingKey,
    };
    const sparkFrost = getSparkFrost();
    const shareForOne = await sparkFrost.signFrost({
      ...baseParams,
      keyPackage: {
        secretKey: ONE,
        publicKey: this.publicKey,
        verifyingKey: params.verifyingKey,
      },
    });
    const shareForTwo = await sparkFrost.signFrost({
      ...baseParams,
      keyPackage: {
        secretKey: TWO,
        publicKey: this.publicKey,
        verifyingKey: params.verifyingKey,
      },
    });

    const z1 = scalarFromBytes(shareForOne);
    const effectiveChallenge = mod(
      scalarFromBytes(shareForTwo) - z1,
      secp256k1.CURVE.n,
    );
    const nonceOnlyShare = mod(z1 - effectiveChallenge, secp256k1.CURVE.n);
    return scalarToBytes(
      nonceOnlyShare + effectiveChallenge * thresholdSecretContribution,
    );
  }

  getSharesForDebug(): DkgShare[] {
    return this.shares;
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
): PublicOnlyChillDkgSparkSigner {
  return new PublicOnlyChillDkgSparkSigner(publicKeyFromGroupFile(groupPath));
}

export function createChillDkgSparkSignerFromShareFiles(
  groupPath: string,
  sharePaths: string[],
): ReturnType<typeof createChillDkgSparkSigner> {
  const artifact = artifactFromSplitFiles(groupPath, sharePaths);
  return createChillDkgSparkSigner(
    artifact,
    artifact.participantsOutput.map((participant) => participant.index),
  );
}

export function createChillDkgSparkSigner(
  artifact = loadArtifact(),
  selected = selectedSignerIndexes(),
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
  return {
    artifact,
    publicKey,
    negateShares,
    shares,
    signer: new ChillDkgSparkSigner({ publicKey, shares }),
  };
}

export function reconstructSelectedSecret(shares: DkgShare[]): bigint {
  return shares.reduce((sum, share) => {
    const lambda = lagrangeCoefficientAtZero(
      BigInt(share.index),
      shares.map((selected) => BigInt(selected.index)),
    );
    return mod(sum + lambda * share.value, secp256k1.CURVE.n);
  }, 0n);
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
