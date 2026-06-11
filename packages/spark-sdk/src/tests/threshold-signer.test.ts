import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import {
  KeyDerivationType,
  ThresholdSparkSigner,
  UnsafeStatelessSparkSigner,
  type KeyDerivation,
  type SigningCommitment,
} from "../index-shared.js";

describe("ThresholdSparkSigner", () => {
  const seed = new Uint8Array(32).fill(7);
  const keyDerivation: KeyDerivation = {
    type: KeyDerivationType.LEAF,
    path: "threshold-demo-leaf",
  };
  const message = sha256("nested-frost-demo");

  async function expectThresholdShareToMatchSingleSigner({
    selectedParticipants,
    statechainCommitments = {},
  }: {
    selectedParticipants: number[];
    statechainCommitments?: { [key: string]: SigningCommitment };
  }) {
    const thresholdSigner = new ThresholdSparkSigner({
      threshold: 2,
      participants: 3,
      selectedParticipants,
    });
    const singleSigner = new UnsafeStatelessSparkSigner();
    await thresholdSigner.createSparkWalletFromSeed(seed, 0);
    await singleSigner.createSparkWalletFromSeed(seed, 0);

    const publicKey =
      await thresholdSigner.getPublicKeyFromDerivation(keyDerivation);
    const singlePublicKey =
      await singleSigner.getPublicKeyFromDerivation(keyDerivation);
    expect(bytesToHex(publicKey)).toEqual(bytesToHex(singlePublicKey));

    const selfCommitment = await thresholdSigner.getRandomSigningCommitment();
    const thresholdShare = await thresholdSigner.signFrost({
      message,
      keyDerivation,
      publicKey,
      verifyingKey: publicKey,
      selfCommitment,
      statechainCommitments,
    });
    const singleShare = await singleSigner.signFrost({
      message,
      keyDerivation,
      publicKey,
      verifyingKey: publicKey,
      selfCommitment,
      statechainCommitments,
    });

    expect(bytesToHex(thresholdShare)).toEqual(bytesToHex(singleShare));
  }

  it.each([
    { label: "1,2", selectedParticipants: [1, 2] },
    { label: "1,3", selectedParticipants: [1, 3] },
    { label: "2,3", selectedParticipants: [2, 3] },
  ])(
    "aggregates signer subset $label into the same virtual leaf share as the single-key signer",
    async ({ selectedParticipants }) => {
      await expectThresholdShareToMatchSingleSigner({ selectedParticipants });
    },
  );

  it("matches the single-key signer with statechain commitments in the transcript", async () => {
    await expectThresholdShareToMatchSingleSigner({
      selectedParticipants: [1, 3],
      statechainCommitments: {
        "0000000000000000000000000000000000000000000000000000000000000003": {
          hiding: hexToBytes(
            "021cf1b3646f95cc6b2f8fd60290733b97bcafab8f0c513289c319bada58c5e01e",
          ),
          binding: hexToBytes(
            "03e9ba1827a469d925cc286f18a7cd1122bcd866f6263f8c49f0441f9d61226e32",
          ),
        },
        "0000000000000000000000000000000000000000000000000000000000000002": {
          hiding: hexToBytes(
            "024acf3d72ce07efaf55f2229895faa936a9c8aa635198953096b7c30ad69492ea",
          ),
          binding: hexToBytes(
            "0259f706606ecf5ef4fa02f5109c1e498c75b4c679d3410e6248a343bdf6419921",
          ),
        },
      },
    });
  });

  it("derives different threshold leaf public keys for different leaf paths", async () => {
    const signer = new ThresholdSparkSigner({
      threshold: 2,
      participants: 3,
      selectedParticipants: [1, 2],
    });
    await signer.createSparkWalletFromSeed(seed, 0);

    const first = await signer.getPublicKeyFromDerivation({
      type: KeyDerivationType.LEAF,
      path: "leaf-a",
    });
    const second = await signer.getPublicKeyFromDerivation({
      type: KeyDerivationType.LEAF,
      path: "leaf-b",
    });

    expect(bytesToHex(first)).not.toEqual(bytesToHex(second));
  });

  it("rejects invalid threshold configurations", () => {
    expect(
      () => new ThresholdSparkSigner({ threshold: 4, participants: 3 }),
    ).toThrow("Invalid threshold configuration");
    expect(
      () =>
        new ThresholdSparkSigner({
          threshold: 2,
          participants: 3,
          selectedParticipants: [1],
        }),
    ).toThrow("Invalid selected participant set");
    expect(
      () =>
        new ThresholdSparkSigner({
          threshold: 2,
          participants: 3,
          selectedParticipants: [1, 1],
        }),
    ).toThrow("Invalid selected participant set");
    expect(
      () =>
        new ThresholdSparkSigner({
          threshold: 2,
          participants: 3,
          selectedParticipants: [1, 4],
        }),
    ).toThrow("Selected participant is out of range");
  });
});
