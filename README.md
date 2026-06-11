# spark-frost

A Spark L2 wallet fork with user-side FROST threshold signing.

`spark-frost` is a slim fork of the Spark JavaScript SDK. It adds a proof-of-concept `ThresholdSparkSigner` so the user's Spark leaf signing key can be represented as a threshold signing group, for example 2-of-3. The Spark operators are unchanged; the nesting happens on the user side.

## What We Built

- A `ThresholdSparkSigner` exported from `@buildonspark/spark-sdk`.
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

This is a research/demo fork. It demonstrates the Spark signing integration and threshold aggregation path, but it is not production FROST yet: there is no real DKG, no remote signer protocol, no hardened share storage, and no distributed nonce coordinator. The current implementation derives the user's deterministic Spark leaf key and Shamir-splits it in process so the SDK path can be exercised end to end.

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
