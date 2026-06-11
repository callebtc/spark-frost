import { SparkWallet } from "@buildonspark/spark-sdk";
import {
  getExampleWalletOptions,
  requireExampleMnemonic,
} from "./wallet-config.js";

const mnemonic = requireExampleMnemonic(process.argv[2]);
const options = getExampleWalletOptions(process.env, "REGTEST");

const { wallet, mnemonic: walletMnemonic } = await SparkWallet.initialize({
  mnemonicOrSeed: mnemonic,
  options,
});
console.log("wallet mnemonic phrase:", walletMnemonic);
console.log("Spark address:", await wallet.getSparkAddress());

for (let attempt = 0; attempt < 6; attempt++) {
  const balance = await wallet.getBalance();
  console.log(`Balance attempt ${attempt + 1}:`, balance);
  if (
    balance.satsBalance.available > 0n &&
    balance.satsBalance.incoming === 0n
  ) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

await wallet.cleanup();
