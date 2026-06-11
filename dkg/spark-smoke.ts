import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/curves/utils";
import { sha256 } from "@noble/hashes/sha2";
import {
  getSparkFrost,
  mergeConfigOptionsForNetwork,
  normalizeNetworkType,
  SparkWallet,
  KeyDerivationType,
  type KeyDerivation,
} from "@buildonspark/spark-sdk";
import {
  createChillDkgSparkSigner,
  reconstructSelectedSecret,
  scalarToBytes,
  type ChillDkgSparkSigner,
} from "./chilldkg-spark-signer.js";

async function runSparkSignatureSmoke(signer: ChillDkgSparkSigner) {
  const keyDerivation = {
    type: KeyDerivationType.LEAF,
    path: "blockstream-chilldkg-smoke",
  } satisfies KeyDerivation;
  const message = sha256("spark-frost blockstream chilldkg compatibility");
  const publicKey = await signer.getPublicKeyFromDerivation(keyDerivation);
  const selfCommitment = await signer.getRandomSigningCommitment();
  console.log("creating Spark FROST self signature share...");
  const selfSignature = await signer.signFrost({
    message,
    keyDerivation,
    publicKey,
    verifyingKey: publicKey,
    selfCommitment,
    statechainCommitments: {},
  });
  const directSelfSignature = await getSparkFrost().signFrost({
    message,
    keyPackage: {
      secretKey: scalarToBytes(
        reconstructSelectedSecret(signer.getSharesForDebug()),
      ),
      publicKey,
      verifyingKey: publicKey,
    },
    nonce: signer.getNonceForSelfCommitment(selfCommitment)!,
    selfCommitment: selfCommitment.commitment,
    statechainCommitments: {},
    adaptorPubKey: undefined,
  });
  console.log(
    "share equals direct Spark signFrost:",
    bytesToHex(selfSignature) === bytesToHex(directSelfSignature),
  );
  let signature: Uint8Array | undefined;
  if (process.env["CHECK_SELF_AGGREGATE"] === "1") {
    console.log("aggregating self-only Spark FROST signature...");
    signature = await getSparkFrost().aggregateFrost({
      message,
      statechainSignatures: {},
      statechainPublicKeys: {},
      verifyingKey: publicKey,
      statechainCommitments: {},
      selfCommitment: selfCommitment.commitment,
      selfPublicKey: publicKey,
      selfSignature,
      adaptorPubKey: undefined,
    });
    const isValid = schnorr.verify(signature, message, publicKey.slice(1, 33));
    if (!isValid) {
      throw new Error("Spark aggregated signature did not verify");
    }
  }
  return { publicKey, signature };
}

async function main() {
  const { artifact, publicKey, negateShares, shares, signer } =
    createChillDkgSparkSigner();
  const reconstructedPoint = secp256k1.Point.BASE.multiply(
    reconstructSelectedSecret(shares),
  );
  console.log("DKG public key from artifact:", artifact.coordinator.thresholdPubkeyHex);
  console.log("Spark/BIP340 normalized public key:", bytesToHex(publicKey));
  console.log("negated odd-y DKG shares for Spark:", negateShares);
  console.log("reconstructed selected secret pubkey:", reconstructedPoint.toHex(true));
  const smoke = await runSparkSignatureSmoke(signer);
  console.log("Spark FROST signature-share smoke passed");
  console.log("DKG threshold public key:", bytesToHex(smoke.publicKey));
  if (smoke.signature) {
    console.log("Spark aggregate signature:", bytesToHex(smoke.signature));
  }

  if (process.env["SKIP_SPARK_WALLET"] === "1") {
    return;
  }

  const network = normalizeNetworkType(process.env["NETWORK"], "REGTEST");
  const { wallet, mnemonic } = await SparkWallet.initialize({
    mnemonicOrSeed: process.env["MNEMONIC"],
    options: mergeConfigOptionsForNetwork(network),
    signer,
  });
  console.log("spark identity mnemonic:", mnemonic);
  console.log("spark address:", await wallet.getSparkAddress());
  console.log(
    "single-use regtest bitcoin deposit address:",
    await wallet.getSingleUseDepositAddress(),
  );
  await wallet.cleanup();
}

main().catch((error) => {
  console.error("ChillDKG Spark smoke failed:", error);
  console.dir(error, { depth: 8 });
  if (error instanceof Error) {
    console.error(error.stack);
    if ("cause" in error) {
      console.error("cause:", error.cause);
    }
  }
  process.exitCode = 1;
});
