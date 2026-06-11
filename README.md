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
- Demo scripts for:
  - creating a FROST-controlled Spark wallet
  - funding it from the REGTEST faucet
  - claiming the deposit into Spark
  - creating a normal Spark receiver wallet
  - sending sats from the FROST wallet to the normal wallet
  - creating and paying a Spark Lightning invoice

This is a research/demo fork. It demonstrates the Spark signing integration and threshold aggregation path, but it is not production FROST yet: there is no remote signer protocol, no hardened share storage, and no distributed nonce coordinator.

There are two threshold demos:

- `demo/` is the fastest end-to-end Spark demo. It derives the user's deterministic Spark leaf key and Shamir-splits it in process so the SDK path can be exercised end to end.
- `dkg/` demonstrates real DKG key generation. It does not start from a composite private key. For the local Spark demo, selected shares are still loaded into one process; a production client would keep each share on its own signer and exchange nonce/signature-share messages.

## How It Works

Spark leaf operations eventually need signatures from the user's leaf key. In this fork, `ThresholdSparkSigner` wraps the default Spark signer and overrides the leaf-signing path.

For a transaction:

1. Spark builds the normal transaction/signing transcript.
2. `ThresholdSparkSigner` derives the same effective user leaf key the normal signer would use.
3. The demo signer splits that key into configurable shares.
4. The selected signer subset, such as participants `1,2` in a 2-of-3, produces partial signatures.
5. The partials are aggregated into the signature Spark expects for the leaf.

The result is API-compatible with normal Spark wallet flows, so deposits, Spark transfers, and Spark Lightning payments can all be driven through the threshold signer.

## Important Files

- `packages/spark-sdk/src/signer/threshold-signer.ts`
- `packages/spark-sdk/src/tests/threshold-signer.test.ts`
- `dkg/chilldkg_keygen.py`
- `dkg/chilldkg-spark-signer.ts`
- `dkg/spark-smoke.ts`
- `dkg/pipeline.ts`
- `demo/create-wallet.ts`
- `demo/normal-wallet.ts`
- `demo/claim-deposit.ts`
- `demo/transfer.ts`
- `demo/pay-invoice.ts`
- `demo/lightning-demo.ts`
- `demo/pipeline.ts`

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

The proposal step uses only `group.txt`. It creates a DKG-controlled Spark wallet, a receiver wallet if needed, and prints the `bcrt1...` deposit address to fund.

Add participant signature shares one by one:

```sh
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-1-share.txt
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-3-share.txt
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-5-share.txt
```

When the threshold is reached, the coordinator aggregates an authorization signature over the proposal. The final Spark transaction or Lightning payment is signed during execution, when the Spark SDK creates the real signing transcript.

Execute after funding the printed `bcrt1...` address at the [Lightspark REGTEST faucet](https://app.lightspark.com/regtest-faucet):

```sh
NETWORK=REGTEST yarn dkg:ceremony execute \
  --proposal output/3-of-5/proposal-transfer.json \
  --faucet-txid "<faucet-txid>"
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

The older compact DKG commands are still useful for smoke testing. Generate a fresh 2-of-3 DKG artifact:

```sh
PYTHON=/path/to/python3.11 yarn dkg:keygen
```

This writes `dkg/state/chilldkg-2of3.json`. The file is ignored because it contains demo host secrets and participant secret shares. No composite private key is generated by the DKG ceremony.

Check that the generated DKG key can drive Spark's FROST leaf-signing path:

```sh
SKIP_SPARK_WALLET=1 yarn dkg:spark-smoke
```

Initialize a REGTEST Spark wallet using that DKG-backed leaf key:

```sh
NETWORK=REGTEST yarn dkg:spark-smoke
```

Run the compact fundable DKG pipeline:

```sh
NETWORK=REGTEST yarn dkg:pipeline
```

The first run prints a `bcrt1...` deposit address. Fund it at the [Lightspark REGTEST faucet](https://app.lightspark.com/regtest-faucet), then rerun:

```sh
NETWORK=REGTEST FAUCET_TXID="<faucet-txid>" yarn dkg:pipeline
```

That resumable DKG pipeline claims the deposit into the DKG-controlled Spark wallet, sends `1000` sats to a normal Spark wallet, creates a Lightning invoice on the normal wallet, and pays it from the DKG-controlled wallet.

Optional DKG pipeline settings:

```sh
NETWORK=REGTEST \
USER_FROST_SIGNERS=1,3 \
TRANSFER_AMOUNT_SATS=1000 \
LIGHTNING_AMOUNT_SATS=100 \
MAX_FEE_SATS=1000 \
yarn dkg:pipeline
```

The default key-generation parameters are configured in `dkg/package.json`. To override them directly:

```sh
cd dkg
PYTHON=/path/to/python3.11 node run-python.mjs chilldkg_keygen.py --threshold 2 --participants 3 --output state/chilldkg-2of3.json
```

## End-to-End REGTEST Demo Pipeline

The easiest demo is the resumable pipeline script. On the first run it creates:

- a FROST-controlled Spark wallet
- a normal Spark receiver wallet
- a single-use `bcrt1...` Bitcoin deposit address for the FROST wallet
- a local state file at `demo/state/regtest-demo.json`

Run:

```sh
NETWORK=REGTEST \
USER_FROST_THRESHOLD=2 \
USER_FROST_PARTICIPANTS=3 \
USER_FROST_SIGNERS=1,2 \
yarn demo:pipeline
```

The script prints a `frost bitcoin deposit address` that starts with `bcrt1`.

Open the [Lightspark REGTEST faucet](https://app.lightspark.com/regtest-faucet), paste that `bcrt1...` address, and request funds. The faucet returns a transaction id.

Then rerun the pipeline with the faucet txid:

```sh
NETWORK=REGTEST \
USER_FROST_THRESHOLD=2 \
USER_FROST_PARTICIPANTS=3 \
USER_FROST_SIGNERS=1,2 \
FAUCET_TXID="<faucet-txid>" \
yarn demo:pipeline
```

That second run does the rest:

1. reopens the saved FROST wallet and normal receiver wallet
2. claims the faucet deposit into the FROST wallet
3. sends `1000` sats from the FROST wallet to the normal Spark wallet
4. creates a Lightning invoice on the normal wallet
5. pays that invoice from the FROST wallet
6. prints final balances

Optional amounts:

```sh
NETWORK=REGTEST \
FAUCET_TXID="<faucet-txid>" \
TRANSFER_AMOUNT_SATS=1000 \
LIGHTNING_AMOUNT_SATS=100 \
MAX_FEE_SATS=1000 \
yarn demo:pipeline
```

The pipeline is resumable. If a step has already been recorded in `demo/state/regtest-demo.json`, rerunning the script skips that recorded step.

If you changed the threshold settings on the first run, use the same `USER_FROST_*` values when resuming with the faucet txid.

If `yarn` is not installed globally, replace `yarn demo:pipeline` with:

```sh
node .yarn/releases/yarn-4.13.0.cjs demo:pipeline
```

## Manual Demo Commands

Create a FROST wallet:

```sh
NETWORK=REGTEST \
USER_FROST_THRESHOLD=2 \
USER_FROST_PARTICIPANTS=3 \
USER_FROST_SIGNERS=1,2 \
yarn demo:create-wallet
```

Fund the printed `single-use regtest bitcoin deposit address` at the [REGTEST faucet](https://app.lightspark.com/regtest-faucet), then claim the faucet txid:

```sh
NETWORK=REGTEST yarn demo:claim-deposit "<frost-mnemonic>" "<faucet-txid>"
```

Create a normal Spark receiver wallet:

```sh
NETWORK=REGTEST yarn demo:normal-wallet
```

Send sats from the FROST wallet to the normal Spark address:

```sh
NETWORK=REGTEST yarn demo:transfer "<frost-mnemonic>" "<receiver-sparkrt1-address>" 1000
```

Run the Lightning demo with a FROST payer and a normal receiver:

```sh
NETWORK=REGTEST yarn demo:lightning "<frost-mnemonic>" "<receiver-mnemonic>" 100 1000
```

Or pay an externally-created invoice directly:

```sh
NETWORK=REGTEST yarn demo:pay-invoice "<frost-mnemonic>" "<bolt11-invoice>" 1000
```

## REGTEST Address Notes

The faucet only accepts REGTEST addresses:

- Bitcoin deposit addresses start with `bcrt1...`
- Spark addresses start with `sparkrt1...`

For this demo, fund the Bitcoin deposit address printed by `demo:create-wallet` or `demo:pipeline`, not the Spark address. After the faucet transaction is mined, `demo:claim-deposit` or `demo:pipeline` claims that Bitcoin deposit into a Spark leaf controlled by the FROST signer.

## Upstream

This fork is based on the Spark JavaScript SDK from [buildonspark/spark](https://github.com/buildonspark/spark). Spark is licensed under Apache-2.0.
