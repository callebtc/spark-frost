# spark-frost

A Spark L2 wallet fork with user-side FROST threshold signing.

`spark-frost` is a slim fork of the Spark JavaScript SDK. It adds a proof-of-concept `ThresholdSparkSigner` so the user's Spark leaf signing key can be represented as a threshold signing group, for example 2-of-3. The Spark operators are unchanged; the nesting happens on the user side.

## What We Built

- A `ThresholdSparkSigner` exported from `@buildonspark/spark-sdk` for an end-to-end Spark demo.
- An isolated `dkg/` demo that runs Blockstream's secp256k1 ChillDKG reference implementation and adapts the generated threshold key to Spark leaf signing.
- Configurable user-side threshold parameters:
  - `USER_FROST_THRESHOLD`, default `2`
  - `USER_FROST_PARTICIPANTS`, default `3`
  - `USER_FROST_SIGNERS`, default `1,2`
- A staged ceremony CLI for:
  - creating DKG keyshare files
  - proposing a Spark transfer or Spark Lightning payment
  - collecting participant signature shares
  - claiming a REGTEST faucet deposit into the DKG-controlled Spark wallet
  - attempting execution without a mnemonic or composite private-key file

This is a research/demo fork. It demonstrates the Spark signing integration and threshold aggregation path, but it is not production FROST yet: there is no remote signer protocol, no hardened share storage, and no distributed nonce coordinator.

Current no-seed DKG status: key generation, Spark wallet initialization, proposal creation, participant authorization signing, and DKG leaf `signFrost` all run without a seed phrase or composite private-key file. Full Spark transfer execution is intentionally blocked when the SDK asks for DKG leaf private-key export to produce Spark operator key-tweak shares. A true no-cheat transfer needs distributed implementations of those key-tweak/share-generation helpers.

The supported demo is `dkg/`. It demonstrates real DKG key generation and does not start from a composite private key. For the local Spark demo, selected shares are still loaded into one process; a production client would keep each share on its own signer and exchange nonce/signature-share messages.

## Coordinator Key

The DKG ceremony writes a `coordinator-key.txt` file next to `group.txt` and the participant share files. This is not the DKG threshold leaf key and it is not a substitute for the participant shares.

Spark still needs a client key to talk to the Spark services. In this demo, `coordinator-key.txt` contains the Spark client identity key plus deposit/static-deposit/HTLC helper keys used for wallet initialization, authentication, deposit handling, and submitting requests to Spark.

Operationally, you can either keep this file with the coordinator process or copy it to the machine that will submit Spark requests. Sharing it gives that machine the ability to identify as this Spark client and propose/submit protocol messages, so it should still be treated as private operational key material. But by itself it must not be enough to move DKG-controlled funds: payments from DKG leaves still require the threshold participant keyshares to produce leaf signatures. In strict mode, this repo refuses to export or reconstruct the DKG leaf private key, so a coordinator with only `coordinator-key.txt` cannot produce Spark leaf signatures.

## How It Works

Spark leaf operations eventually need signatures from the user's leaf key. In this fork, `ThresholdSparkSigner` wraps the default Spark signer and overrides the leaf-signing path.

For a transaction:

1. Spark builds the normal transaction/signing transcript.
2. `ThresholdSparkSigner` derives the same effective user leaf key the normal signer would use.
3. The demo signer splits that key into configurable shares.
4. The selected signer subset, such as participants `1,2` in a 2-of-3, produces partial signatures.
5. The partials are aggregated into the signature Spark expects for the leaf.

The result exercises Spark's leaf-signing API. Full Spark transfers and Spark Lightning payments also require key-tweak/share-generation APIs that currently expect access to derived private leaf material; this fork now refuses that export for DKG leaves instead of reconstructing a composite private key.

## Important Files

- `packages/spark-sdk/src/signer/threshold-signer.ts`
- `packages/spark-sdk/src/tests/threshold-signer.test.ts`
- `dkg/chilldkg_keygen.py`
- `dkg/chilldkg-spark-signer.ts`
- `dkg/spark-smoke.ts`
- `dkg/ceremony.ts`
- `dkg/no-mnemonic-signer.test.ts`

## Setup

Requires Node `>=20.19.0`.

```sh
git clone https://github.com/callebtc/spark-frost.git
cd spark-frost
yarn install
yarn build
```

If `yarn` is not on your PATH, use the checked-in Yarn release:

```sh
node .yarn/releases/yarn-4.13.0.cjs install
node .yarn/releases/yarn-4.13.0.cjs build
```

## Test

```sh
yarn test
yarn types
```

The FROST signer tests confirm that different 2-of-3 signer subsets aggregate into the same effective Spark leaf signature, including statechain commitment transcripts, and that invalid threshold configurations are rejected.

## Real DKG Demo

The DKG demo lives under `dkg/` so it does not pollute the SDK package. We evaluated `mycelial-systems/frost-dkg`, but the published package is Ed25519-based, which does not match Spark's secp256k1/BIP340 leaf signing. This repo therefore vendors the Python reference code from [BlockstreamResearch/bip-frost-dkg](https://github.com/BlockstreamResearch/bip-frost-dkg), which implements ChillDKG for secp256k1 FROST.

You need Python `>=3.11` for the Blockstream reference. If your system `python3` is older, set `PYTHON=/path/to/python3.11`.

The most educational path is the staged ceremony CLI. It writes a public group file and one keyshare text file per participant, then uses those files in a proposal/sign/execute flow.

For the simplest guided demo, run:

```sh
PYTHON=/path/to/python3.11 NETWORK=REGTEST yarn dkg:demo
```

That creates a default 2-of-3 DKG wallet, writes separate participant keyshare files, proposes a 1000 sat Spark transfer, walks through collecting two participant signatures, and then pauses at the faucet funding step. After funding the printed `bcrt1...` address, rerun the printed `execute` command with the faucet txid.

For the same guided flow with a Lightning payment:

```sh
PYTHON=/path/to/python3.11 NETWORK=REGTEST yarn dkg:demo:lightning
```

Create keyshares for a 3-of-5 wallet:

```sh
PYTHON=/path/to/python3.11 yarn dkg:ceremony keygen --threshold 3 --participants 5 --out output/3-of-5
```

This writes:

- `dkg/output/3-of-5/group.txt`
- `dkg/output/3-of-5/participant-1-share.txt`
- `dkg/output/3-of-5/participant-2-share.txt`
- `dkg/output/3-of-5/participant-3-share.txt`
- `dkg/output/3-of-5/participant-4-share.txt`
- `dkg/output/3-of-5/participant-5-share.txt`

The output directory is ignored because the participant files contain demo secret shares.

Have the coordinator propose a Spark transfer:

```sh
NETWORK=REGTEST yarn dkg:ceremony propose \
  --group output/3-of-5/group.txt \
  --proposal output/3-of-5/proposal-transfer.json \
  --kind transfer \
  --amount 1000
```

Or propose a Lightning payment:

```sh
NETWORK=REGTEST yarn dkg:ceremony propose \
  --group output/3-of-5/group.txt \
  --proposal output/3-of-5/proposal-lightning.json \
  --kind lightning \
  --amount 100
```

The keygen step also writes `coordinator-key.txt`. See [Coordinator Key](#coordinator-key) for the trust boundary around this file.

The proposal step uses `group.txt` plus `coordinator-key.txt`. It creates a DKG-controlled Spark wallet, a receiver wallet if needed, and prints the `bcrt1...` deposit address to fund.

Add participant signature shares one by one:

```sh
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-1-share.txt
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-3-share.txt
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-5-share.txt
```

When the threshold is reached, the coordinator aggregates an authorization signature over the proposal. The final Spark transaction or Lightning payment needs Spark's runtime signing transcript and key-tweak helpers during execution.

Execute after funding the printed `bcrt1...` address at the [Lightspark REGTEST faucet](https://app.lightspark.com/regtest-faucet):

```sh
NETWORK=REGTEST yarn dkg:ceremony execute \
  --proposal output/3-of-5/proposal-transfer.json \
  --faucet-txid "<faucet-txid>"
```

With the current strict no-private-export signer, execution can claim/check funds but a full transfer will fail once Spark asks for DKG leaf private-key material to build operator key-tweak shares. That failure is intentional until distributed key-tweak helpers are implemented.

If Spark has recorded the claim but the leaf is not spendable yet, `execute` waits for available balance before trying to send. You can tune that wait:

```sh
NETWORK=REGTEST yarn dkg:ceremony execute \
  --proposal output/3-of-5/proposal-transfer.json \
  --faucet-txid "<faucet-txid>" \
  --wait-seconds 180
```

After the sender transfer succeeds, the receiver may briefly show the funds as `incoming`. The CLI waits for the receiver to auto-claim before cleanup; tune that with `--receiver-wait-seconds 180`.

To send again from an already-funded FROST wallet to a fresh Spark address, create a new transfer proposal with the same group file and coordinator key file. Omit `--receiver-spark-address` so the CLI creates a fresh receiver wallet, collect threshold signatures again, then execute with `--skip-claim`:

```sh
NETWORK=REGTEST yarn dkg:ceremony propose \
  --group output/demo-transfer/group.txt \
  --coordinator-key output/demo-transfer/coordinator-key.txt \
  --proposal output/demo-transfer/send-fresh.json \
  --kind transfer \
  --amount 1000

yarn dkg:ceremony sign \
  --proposal output/demo-transfer/send-fresh.json \
  --share output/demo-transfer/participant-1-share.txt

yarn dkg:ceremony sign \
  --proposal output/demo-transfer/send-fresh.json \
  --share output/demo-transfer/participant-2-share.txt

NETWORK=REGTEST yarn dkg:ceremony execute \
  --proposal output/demo-transfer/send-fresh.json \
  --skip-claim
```

For a guided single command walkthrough:

```sh
PYTHON=/path/to/python3.11 NETWORK=REGTEST yarn dkg:ceremony walkthrough \
  --threshold 2 \
  --participants 3 \
  --out output/walkthrough \
  --kind transfer \
  --amount 1000
```

Add `--yes` to skip the interactive pauses. Add `--faucet-txid <txid>` if the generated deposit address has already been funded.

The older compact DKG commands are still useful for smoke testing the signer internals. They are less educational than the staged ceremony because they keep demo state in one resumable file instead of separate participant keyshare files. Generate a fresh 2-of-3 DKG artifact:

```sh
PYTHON=/path/to/python3.11 yarn dkg:keygen
```

This writes `dkg/state/chilldkg-2of3.json`. The file is ignored because it contains demo host secrets and participant secret shares. No composite private key is generated by the DKG ceremony.

Check that the generated DKG key can drive Spark's FROST leaf-signing path:

```sh
yarn dkg:spark-smoke
```

The default key-generation parameters are configured in `dkg/package.json`. To override them directly:

```sh
cd dkg
PYTHON=/path/to/python3.11 node run-python.mjs chilldkg_keygen.py --threshold 2 --participants 3 --output state/chilldkg-2of3.json
```

## REGTEST Address Notes

The faucet only accepts REGTEST addresses:

- Bitcoin deposit addresses start with `bcrt1...`
- Spark addresses start with `sparkrt1...`

For this demo, fund the Bitcoin deposit address printed by `yarn dkg:ceremony propose` or `yarn dkg:demo`, not the Spark address. After the faucet transaction is mined, `yarn dkg:ceremony execute --faucet-txid <txid>` claims that Bitcoin deposit into a Spark leaf controlled by the DKG threshold signer.

## Upstream

This fork is based on the Spark JavaScript SDK from [buildonspark/spark](https://github.com/buildonspark/spark). Spark is licensed under Apache-2.0.
