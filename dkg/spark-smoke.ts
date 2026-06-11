import { bytesToHex } from "@noble/curves/utils";
import { sha256 } from "@noble/hashes/sha2";
import {
  KeyDerivationType,
  type KeyDerivation,
} from "@buildonspark/spark-sdk";
import {
  createChillDkgSparkSigner,
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
  console.log("Spark FROST signature share:", bytesToHex(selfSignature));
  return { publicKey };
}

async function main() {
  const { artifact, publicKey, negateShares, signer } = createChillDkgSparkSigner();
  console.log("DKG public key from artifact:", artifact.coordinator.thresholdPubkeyHex);
  console.log("Spark/BIP340 normalized public key:", bytesToHex(publicKey));
  console.log("negated odd-y DKG shares for Spark:", negateShares);
  const smoke = await runSparkSignatureSmoke(signer);
  console.log("Spark FROST signature-share smoke passed");
  console.log("Spark path-derived leaf public key:", bytesToHex(smoke.publicKey));

  console.log("Use `yarn dkg:ceremony` for the fundable no-mnemonic wallet demo.");
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
