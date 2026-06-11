import { mod } from "@noble/curves/abstract/modular";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  bytesToNumberBE,
  hexToBytes,
  numberToBytesBE,
} from "@noble/curves/utils";
import { sha256 } from "@noble/hashes/sha2";
import { HDKey } from "@scure/bip32";
import { SparkValidationError } from "../errors/index.js";
import { getSparkFrost } from "../spark-bindings/spark-bindings.js";
import { getSigningCommitmentFromNonce } from "../utils/signing.js";
import { DefaultSparkSigner } from "./signer.js";
import {
  KeyDerivationType,
  type KeyDerivation,
  type SignFrostParams,
  type SigningCommitment,
  type SigningCommitmentWithOptionalNonce,
  type SigningNonce,
} from "./types.js";

export type ThresholdSparkSignerOptions = {
  threshold: number;
  participants: number;
  selectedParticipants?: number[];
};

type ScalarShare = {
  index: number;
  value: bigint;
};

type LeafThresholdState = {
  publicKey: Uint8Array;
  shares: ScalarShare[];
};

type ThresholdNonceState = {
  aggregateNonce: SigningNonce;
  participantNonces: Array<{
    index: number;
    binding: bigint;
    hiding: bigint;
  }>;
};

const HARDENED_OFFSET = 0x80000000;
const ONE = numberToBytesBE(1n, 32);
const TWO = numberToBytesBE(2n, 32);

/**
 * Demonstration signer for nested FROST-style Spark leaf signing.
 *
 * Spark still sees one logical user participant. Internally, this signer splits
 * each leaf signing scalar into Shamir shares, aggregates threshold nonce shares,
 * and returns one virtual user signature share for Spark's existing FROST flow.
 *
 * This class intentionally delegates identity/deposit/static-deposit behavior to
 * DefaultSparkSigner so Spark auth and wallet setup keep working unchanged.
 * The initial shares are dealer-generated from the derived leaf secret; replace
 * that with DKG before considering this production key management.
 */
export class ThresholdSparkSigner extends DefaultSparkSigner {
  private readonly threshold: number;
  private readonly participants: number;
  private readonly selectedParticipants: number[];
  private readonly leafStates = new Map<string, LeafThresholdState>();
  private readonly thresholdNonceStates = new Map<
    string,
    ThresholdNonceState
  >();
  private signingRoot: HDKey | null = null;

  constructor({
    threshold,
    participants,
    selectedParticipants,
  }: ThresholdSparkSignerOptions) {
    super();
    if (threshold < 1 || participants < 1 || threshold > participants) {
      throw new SparkValidationError("Invalid threshold configuration", {
        field: "threshold",
        value: `${threshold}-of-${participants}`,
        expected: "1 <= threshold <= participants",
      });
    }

    const selected =
      selectedParticipants ??
      Array.from({ length: threshold }, (_, i) => i + 1);
    if (
      selected.length !== threshold ||
      new Set(selected).size !== selected.length
    ) {
      throw new SparkValidationError("Invalid selected participant set", {
        field: "selectedParticipants",
        value: selected.join(","),
        expected: `${threshold} unique participant indexes`,
      });
    }
    for (const index of selected) {
      if (!Number.isInteger(index) || index < 1 || index > participants) {
        throw new SparkValidationError("Selected participant is out of range", {
          field: "selectedParticipants",
          value: index,
          expected: `integer in [1, ${participants}]`,
        });
      }
    }

    this.threshold = threshold;
    this.participants = participants;
    this.selectedParticipants = selected;
  }

  override async createSparkWalletFromSeed(
    seed: Uint8Array | string,
    accountNumber = 0,
  ): Promise<string> {
    const seedBytes = typeof seed === "string" ? hexToBytesLocal(seed) : seed;
    const identityPublicKey = await super.createSparkWalletFromSeed(
      seedBytes,
      accountNumber,
    );

    const hdkey = HDKey.fromMasterSeed(seedBytes);
    const signingRoot = hdkey.derive(`m/8797555'/${accountNumber}'/1'`);
    if (!signingRoot.privateKey || !signingRoot.publicKey) {
      throw new SparkValidationError(
        "Failed to derive threshold signing root",
        {
          field: "signingRoot",
        },
      );
    }
    this.signingRoot = signingRoot;
    this.leafStates.clear();
    this.thresholdNonceStates.clear();

    return identityPublicKey;
  }

  override async getPublicKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    if (keyDerivation?.type === KeyDerivationType.LEAF) {
      return this.getOrCreateLeafState(keyDerivation.path).publicKey;
    }
    return super.getPublicKeyFromDerivation(keyDerivation);
  }

  override getRandomSigningCommitment(): Promise<SigningCommitmentWithOptionalNonce> {
    const participantNonces = this.selectedParticipants.map((index) => ({
      index,
      binding: randomScalar(),
      hiding: randomScalar(),
    }));

    const aggregateNonce = {
      binding: scalarToBytes(
        participantNonces.reduce(
          (sum, nonce) => mod(sum + nonce.binding, secp256k1.CURVE.n),
          0n,
        ),
      ),
      hiding: scalarToBytes(
        participantNonces.reduce(
          (sum, nonce) => mod(sum + nonce.hiding, secp256k1.CURVE.n),
          0n,
        ),
      ),
    };
    const commitment = getSigningCommitmentFromNonce(aggregateNonce);

    this.thresholdNonceStates.set(commitmentKey(commitment), {
      aggregateNonce,
      participantNonces,
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

    const leafState = this.getOrCreateLeafState(params.keyDerivation.path);
    const nonceState = this.thresholdNonceStates.get(
      commitmentKey(params.selfCommitment.commitment),
    );
    if (!nonceState) {
      throw new SparkValidationError(
        "Threshold nonce not found for commitment",
        {
          field: "selfCommitment",
        },
      );
    }

    const selectedShares = this.selectedParticipants.map((index) => {
      const share = leafState.shares.find(
        (candidate) => candidate.index === index,
      );
      if (!share) {
        throw new SparkValidationError("Missing selected threshold share", {
          field: "selectedParticipants",
          value: index,
        });
      }
      return share;
    });

    const thresholdSecretContribution = selectedShares.reduce((sum, share) => {
      const lambda = lagrangeCoefficientAtZero(
        BigInt(share.index),
        selectedShares.map((selected) => BigInt(selected.index)),
      );
      return mod(sum + lambda * share.value, secp256k1.CURVE.n);
    }, 0n);

    const baseParams = {
      message: params.message,
      nonce: nonceState.aggregateNonce,
      selfCommitment: params.selfCommitment.commitment,
      statechainCommitments: params.statechainCommitments ?? {},
      adaptorPubKey: params.adaptorPubKey,
      publicKey: leafState.publicKey,
      verifyingKey: params.verifyingKey,
    };
    const sparkFrost = getSparkFrost();

    const shareForOne = await sparkFrost.signFrost({
      ...baseParams,
      keyPackage: {
        secretKey: ONE,
        publicKey: leafState.publicKey,
        verifyingKey: params.verifyingKey,
      },
    });
    const shareForTwo = await sparkFrost.signFrost({
      ...baseParams,
      keyPackage: {
        secretKey: TWO,
        publicKey: leafState.publicKey,
        verifyingKey: params.verifyingKey,
      },
    });

    const z1 = scalarFromBytes(shareForOne);
    const effectiveChallenge = mod(
      scalarFromBytes(shareForTwo) - z1,
      secp256k1.CURVE.n,
    );
    const nonceOnlyShare = mod(z1 - effectiveChallenge, secp256k1.CURVE.n);
    const thresholdShare = mod(
      nonceOnlyShare + effectiveChallenge * thresholdSecretContribution,
      secp256k1.CURVE.n,
    );

    return scalarToBytes(thresholdShare);
  }

  private getOrCreateLeafState(path: string): LeafThresholdState {
    const existing = this.leafStates.get(path);
    if (existing) {
      return existing;
    }

    const privateKey = this.deriveThresholdLeafPrivateKey(path);
    const secret = scalarFromBytes(privateKey);
    const shares = splitShamirSecret(secret, this.threshold, this.participants);
    const state = {
      publicKey: secp256k1.getPublicKey(privateKey, true),
      shares,
    };
    this.leafStates.set(path, state);
    return state;
  }

  private deriveThresholdLeafPrivateKey(path: string): Uint8Array {
    if (!this.signingRoot) {
      throw new SparkValidationError("Threshold signer is not initialized", {
        field: "signingRoot",
      });
    }
    const hash = sha256(path);
    const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
    const childIndex =
      (view.getUint32(0, false) % HARDENED_OFFSET) + HARDENED_OFFSET;
    const child = this.signingRoot.deriveChild(childIndex);
    if (!child.privateKey) {
      throw new SparkValidationError("Failed to derive threshold leaf key", {
        field: "leafPrivateKey",
      });
    }
    return child.privateKey;
  }
}

function splitShamirSecret(
  secret: bigint,
  threshold: number,
  participants: number,
): ScalarShare[] {
  const coefficients = [
    secret,
    ...Array.from({ length: threshold - 1 }, () => randomScalar()),
  ];
  return Array.from({ length: participants }, (_, i) => {
    const x = BigInt(i + 1);
    const value = coefficients.reduce(
      (sum, coefficient, power) =>
        mod(
          sum + coefficient * modPow(x, BigInt(power), secp256k1.CURVE.n),
          secp256k1.CURVE.n,
        ),
      0n,
    );
    return { index: i + 1, value };
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
    throw new SparkValidationError("Cannot invert zero scalar", {
      field: "scalar",
    });
  }
  return modPow(value, secp256k1.CURVE.n - 2n, secp256k1.CURVE.n);
}

function randomScalar(): bigint {
  return scalarFromBytes(secp256k1.utils.randomPrivateKey());
}

function scalarFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new SparkValidationError("Expected 32-byte scalar", {
      field: "scalar",
      value: bytes.length,
      expected: 32,
    });
  }
  return bytesToNumberBE(bytes);
}

function scalarToBytes(value: bigint): Uint8Array {
  return numberToBytesBE(mod(value, secp256k1.CURVE.n), 32);
}

function commitmentKey(commitment: SigningCommitment): string {
  return `${bytesToHex(commitment.hiding)}:${bytesToHex(commitment.binding)}`;
}

function hexToBytesLocal(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new SparkValidationError("Hex string must have an even length", {
      field: "seed",
      value: hex.length,
    });
  }
  return hexToBytes(hex);
}
