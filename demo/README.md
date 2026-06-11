# spark-frost demo

These scripts demonstrate a Spark wallet whose user leaf signing key is controlled by `ThresholdSparkSigner`.

The default configuration is 2-of-3:

```sh
USER_FROST_THRESHOLD=2 USER_FROST_PARTICIPANTS=3 USER_FROST_SIGNERS=1,2
```

The scripts default to `NETWORK=REGTEST`.

## Full Pipeline

Run once to create a FROST wallet, a normal receiver wallet, and a `bcrt1...` deposit address:

```sh
NETWORK=REGTEST yarn demo:pipeline
```

Fund the printed `frost bitcoin deposit address` at the [Lightspark REGTEST faucet](https://app.lightspark.com/regtest-faucet), then rerun with the returned txid:

```sh
NETWORK=REGTEST \
USER_FROST_THRESHOLD=2 \
USER_FROST_PARTICIPANTS=3 \
USER_FROST_SIGNERS=1,2 \
FAUCET_TXID="<faucet-txid>" \
yarn demo:pipeline
```

The second run claims the deposit, sends a Spark transfer to the normal wallet, creates a Lightning invoice, and pays it from the FROST wallet.

## Create a FROST Wallet

```sh
NETWORK=REGTEST yarn demo:create-wallet
```

This prints a mnemonic, Spark address, identity public key, current balance, and a single-use Bitcoin deposit address.

## Claim a Funded Deposit

```sh
NETWORK=REGTEST yarn demo:claim-deposit "<mnemonic>" "<bitcoin-txid>"
```

## Send a Spark Transfer

```sh
NETWORK=REGTEST yarn demo:transfer "<mnemonic>" "sparkrt1..." 1000
```

## Pay a Lightning Invoice

```sh
NETWORK=REGTEST yarn demo:pay-invoice "<mnemonic>" "<bolt11-invoice>" 1000
```

## End-to-End Lightning Smoke Demo

```sh
NETWORK=REGTEST yarn demo:lightning "<frost-mnemonic>" "<receiver-mnemonic>" 100 1000
```

This creates a normal receiver wallet invoice and pays it from the FROST signer wallet.

## Notes

This is a local proof of concept. The current signer demonstrates the Spark SDK integration point and threshold signature aggregation semantics, but it does not yet provide production DKG, remote signer transport, hardened share storage, or distributed nonce handling.
