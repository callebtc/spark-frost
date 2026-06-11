export interface SparkCrypto {
  // Browser
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  // Node.js
  getRandomValues<T extends ArrayBuffer | ArrayBufferView>(array: T): T;
}

let cryptoImpl: SparkCrypto | null = globalThis.crypto ?? null;

export const getCrypto = () => {
  if (!cryptoImpl) {
    throw new Error(
      "Crypto implementation is not set. Please set it using setCrypto().",
    );
  }

  return cryptoImpl;
};

export const setCrypto = (cryptoImplParam: SparkCrypto | null): void => {
  cryptoImpl = cryptoImplParam;
};
