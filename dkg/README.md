# spark-frost DKG demo

This directory contains isolated key-generation experiments for `spark-frost`.

The DKG implementation is vendored from
`BlockstreamResearch/bip-frost-dkg`, which specifies ChillDKG for secp256k1
FROST. That curve family matches Spark's Bitcoin/Schnorr leaf-signing needs.

Generated artifacts are written under `dkg/state/` or `dkg/output/`, which are
ignored because they contain demo host secrets and participant secret shares.

## Staged Ceremony CLI

The most educational demo is `yarn dkg:ceremony`. It separates the flow into
three stages:

1. Create distributed keyshares.
2. Propose a Spark transfer or Lightning payment and collect participant
   signature shares one by one.
3. Execute the funded Spark action using the collected threshold shares.

Current strict mode refuses to export or reconstruct a DKG leaf private key. That
means proposal/signing works without a mnemonic or composite key, but full Spark
transfer execution is blocked until the Spark key-tweak/share-generation helper
APIs are implemented as distributed protocols.

## Coordinator Key

The ceremony writes `coordinator-key.txt` next to `group.txt` and the participant
share files. This file is not the DKG threshold leaf key.

Spark still needs a client key for wallet initialization, authentication,
deposit handling, and submitting requests to Spark. In this demo, those Spark
client identity/deposit/static-deposit/HTLC helper keys live in
`coordinator-key.txt`.

The file can live with the coordinator process, or it can be copied to whichever
machine submits Spark requests. Whoever has it can identify as this Spark
client and submit protocol messages, so it should be treated as private
operational key material. But it is not enough to move DKG-controlled funds:
payments from DKG leaves still require threshold participant keyshares. In
strict mode, this repo refuses to export or reconstruct the DKG leaf private
key, so a coordinator with only `coordinator-key.txt` cannot produce Spark leaf
signatures.

For the simplest guided demo from the repo root, run:

```sh
PYTHON=/path/to/python3.11 NETWORK=REGTEST yarn dkg:demo
```

For the Lightning version:

```sh
PYTHON=/path/to/python3.11 NETWORK=REGTEST yarn dkg:demo:lightning
```

Create keyshares for a 3-of-5 wallet:

```sh
PYTHON=/path/to/python3.11 yarn dkg:ceremony keygen --threshold 3 --participants 5 --out output/3-of-5
```

This writes a public coordinator file plus one private text file per
participant:

- `output/3-of-5/group.txt`
- `output/3-of-5/participant-1-share.txt`
- `output/3-of-5/participant-2-share.txt`
- `output/3-of-5/participant-3-share.txt`
- `output/3-of-5/participant-4-share.txt`
- `output/3-of-5/participant-5-share.txt`

Propose a Spark transfer:

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

The keygen step also writes `coordinator-key.txt`; see [Coordinator Key](#coordinator-key)
for the trust boundary around this file.

The proposal step uses the public `group.txt` plus `coordinator-key.txt`. It
prints the DKG-controlled Spark address and the `bcrt1...` Bitcoin deposit
address to fund.

Add participants one by one:

```sh
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-1-share.txt
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-3-share.txt
yarn dkg:ceremony sign --proposal output/3-of-5/proposal-transfer.json --share output/3-of-5/participant-5-share.txt
```

When the threshold is reached, the coordinator aggregates an authorization
signature over the proposal. The actual Spark transaction or Lightning payment
is signed during execution because Spark creates the final signing transcript at
that point.

After funding the printed deposit address at the REGTEST faucet, execute:

```sh
NETWORK=REGTEST yarn dkg:ceremony execute \
  --proposal output/3-of-5/proposal-transfer.json \
  --faucet-txid "<faucet-txid>"
```

If Spark has recorded the claim but the leaf is not spendable yet, `execute`
waits for available balance before sending. Use `--wait-seconds 180` to wait
longer.

Once a send reaches Spark's key-tweak/share-generation step, the strict DKG
signer intentionally fails rather than exporting a reconstructed leaf private
key.

After the sender transfer succeeds, the receiver may briefly show the funds as
`incoming`. The CLI waits for the receiver to auto-claim before cleanup; use
`--receiver-wait-seconds 180` to wait longer.

To spend from an already-funded FROST wallet, create a new proposal with the
same group file and coordinator key file, collect threshold signatures again,
and execute with `--skip-claim` instead of a faucet txid.

For a guided one-command walkthrough:

```sh
PYTHON=/path/to/python3.11 NETWORK=REGTEST yarn dkg:ceremony walkthrough \
  --threshold 2 \
  --participants 3 \
  --out output/walkthrough \
  --kind transfer \
  --amount 1000
```

## Run ChillDKG

```sh
yarn dkg:keygen
```

The Blockstream reference requires Python `>=3.11`. If your default `python3` is
older, run:

```sh
PYTHON=/path/to/python3.11 yarn dkg:keygen
```

This writes `dkg/state/chilldkg-2of3.json` with:

- the threshold public key
- each participant's secret share
- each participant's public share
- recovery data
- host keys used for the demo ceremony

No composite private key is generated by ChillDKG.

## Spark Compatibility Smoke Test

```sh
yarn dkg:spark-smoke
```

The smoke test reads the ChillDKG artifact, builds a local Spark-compatible
threshold signer from the participant shares, and confirms the generated Spark
FROST signature share matches Spark's direct signing path for the same
threshold public key.

This is still a local demo: secret shares are loaded into one process for the
smoke test. A production version would keep each share on its own signer device
and coordinate nonce/signature-share messages remotely.
