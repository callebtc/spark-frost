import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mod } from "@noble/curves/abstract/modular";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  bytesToNumberBE,
  numberToBytesBE,
} from "@noble/curves/utils";
import { KeyDerivationType } from "@buildonspark/spark-sdk";
import {
  createChillDkgSparkSignerFromShareFiles,
  createPublicOnlyChillDkgSparkSigner,
  deriveDkgLeafPublicKey,
  normalizeSparkPublicKey,
} from "./chilldkg-spark-signer.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-frost-no-mnemonic-"));

function privateScalar(): bigint {
  return bytesToNumberBE(secp256k1.utils.randomPrivateKey());
}

function scalarHex(value: bigint): string {
  return bytesToHex(numberToBytesBE(mod(value, secp256k1.CURVE.n), 32));
}

function writeJson(filePath: string, value: unknown): string {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

const threshold = 2;
const participants = 3;
const secret = privateScalar();
const slope = privateScalar();
const shareScalars = Array.from({ length: participants }, (_, index) =>
  mod(secret + slope * BigInt(index + 1), secp256k1.CURVE.n),
);
const pubshareHexes = shareScalars.map((share) =>
  secp256k1.Point.BASE.multiply(share).toHex(true),
);
const thresholdPubkeyHex = secp256k1.Point.BASE.multiply(secret).toHex(true);
const paramsIdHex = "00".repeat(32);

const groupFile = writeJson(path.join(tmp, "group.txt"), {
  kind: "spark-frost-chilldkg-group",
  version: 1,
  threshold,
  participants,
  participantIndexBase: 1,
  paramsIdHex,
  coordinator: {
    thresholdPubkeyHex,
  },
});

const shareFiles = shareScalars.map((share, index) =>
  writeJson(path.join(tmp, `participant-${index + 1}-share.txt`), {
    kind: "spark-frost-chilldkg-keyshare",
    version: 1,
    threshold,
    participants,
    participantIndexBase: 1,
    paramsIdHex,
    index: index + 1,
    secshareHex: scalarHex(share),
    thresholdPubkeyHex,
    pubshareHexes,
  }),
);

const identityPrivateKey = secp256k1.utils.randomPrivateKey();
const depositPrivateKey = secp256k1.utils.randomPrivateKey();
const coordinatorKeyFile = writeJson(path.join(tmp, "coordinator-key.txt"), {
  kind: "spark-frost-coordinator-keys",
  version: 1,
  identityPrivateKeyHex: bytesToHex(identityPrivateKey),
  depositPrivateKeyHex: bytesToHex(depositPrivateKey),
  staticDepositPrivateKeyHex: bytesToHex(secp256k1.utils.randomPrivateKey()),
  htlcPreimagePrivateKeyHex: bytesToHex(secp256k1.utils.randomPrivateKey()),
});

const publicOnlySigner = createPublicOnlyChillDkgSparkSigner(
  groupFile,
  coordinatorKeyFile,
);

assert.equal(
  bytesToHex(await publicOnlySigner.getIdentityPublicKey()),
  bytesToHex(secp256k1.getPublicKey(identityPrivateKey)),
);
assert.throws(
  () => publicOnlySigner.generateMnemonic(),
  /does not generate mnemonics/,
);
assert.throws(
  () => publicOnlySigner.mnemonicToSeed("unused"),
  /does not use mnemonics/,
);
assert.throws(
  () => publicOnlySigner.createSparkWalletFromSeed(new Uint8Array(32)),
  /pre-existing keys/,
);

const leafPath = "test-leaf-id";
assert.equal(
  bytesToHex(
    await publicOnlySigner.getPublicKeyFromDerivation({
      type: KeyDerivationType.LEAF,
      path: leafPath,
    }),
  ),
  bytesToHex(
    deriveDkgLeafPublicKey(
      normalizeSparkPublicKey(Buffer.from(thresholdPubkeyHex, "hex")),
      leafPath,
    ),
  ),
);
await assert.rejects(
  () =>
    publicOnlySigner.signFrost({
      message: new Uint8Array(32),
      keyDerivation: {
        type: KeyDerivationType.LEAF,
        path: leafPath,
      },
      publicKey: secp256k1.getPublicKey(identityPrivateKey),
      verifyingKey: secp256k1.getPublicKey(identityPrivateKey),
      selfCommitment: {
        commitment: {
          binding: secp256k1.getPublicKey(identityPrivateKey),
          hiding: secp256k1.getPublicKey(identityPrivateKey),
        },
      },
      statechainCommitments: {},
    }),
  /public-only DKG signer cannot sign Spark leaf messages/,
);

const { signer: executionSigner } = createChillDkgSparkSignerFromShareFiles(
  groupFile,
  shareFiles.slice(0, threshold),
  { coordinatorKeyPath: coordinatorKeyFile },
);

assert.equal(
  bytesToHex(await executionSigner.getIdentityPublicKey()),
  bytesToHex(secp256k1.getPublicKey(identityPrivateKey)),
);
assert.equal(
  bytesToHex(await executionSigner.getDepositSigningKey()),
  bytesToHex(secp256k1.getPublicKey(depositPrivateKey)),
);
await assert.rejects(
  () =>
    executionSigner.subtractAndSplitSecretWithProofsGivenDerivations({
      first: {
        type: KeyDerivationType.LEAF,
        path: "old-leaf",
      },
      second: {
        type: KeyDerivationType.LEAF,
        path: "new-leaf",
      },
      curveOrder: secp256k1.CURVE.n,
      threshold: 2,
      numShares: 3,
    }),
  /DKG leaf private-key export is disabled/,
);
assert.throws(
  () => executionSigner.generateMnemonic(),
  /does not generate mnemonics/,
);
assert.throws(
  () => executionSigner.createSparkWalletFromSeed(new Uint8Array(32)),
  /pre-existing keys/,
);

console.log("no-mnemonic DKG signer regression passed");
