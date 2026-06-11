import { SparkWallet } from "@buildonspark/spark-sdk";
import {
  getExampleMnemonic,
  getExampleWalletOptions,
} from "./wallet-config.js";

async function main() {
  const { wallet, mnemonic } = await SparkWallet.initialize({
    mnemonicOrSeed: getExampleMnemonic(process.argv[2]),
    options: getExampleWalletOptions(process.env, "REGTEST"),
  });

  console.log("wallet mnemonic phrase:", mnemonic);
  console.log("identity public key:", await wallet.getIdentityPublicKey());
  console.log("spark address:", await wallet.getSparkAddress());
  console.log("balance:", await wallet.getBalance());

  await wallet.cleanup();
}

main().catch((error) => {
  console.error("Normal Spark wallet creation failed:", error);
  process.exitCode = 1;
});
