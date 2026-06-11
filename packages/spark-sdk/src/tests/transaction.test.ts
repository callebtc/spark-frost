import { checkIfValidSequence } from "../utils/transaction.js";

describe("checkIfValidSequence", () => {
  it("should throw an error if the sequence is not valid", () => {
    const noTimelockSequence = (1 << 31) | 1000;
    expect(() => checkIfValidSequence(noTimelockSequence)).toThrow();
    const secondstimelockSequence = (1 << 22) | 1000;
    expect(() => checkIfValidSequence(secondstimelockSequence)).toThrow();
    const sequence = 1000;
    expect(() => checkIfValidSequence(sequence)).not.toThrow();
  });
});
