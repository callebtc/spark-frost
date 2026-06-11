import { FRAGMENT as CoopExitFeeQuoteFragment } from "../objects/CoopExitFeeQuote.js";

export const GetCoopExitFeeQuote = `
  query CoopExitFeeQuote(
    $leaf_external_ids: [UUID!]!
    $withdrawal_address: String!
  ) {
    coop_exit_fee_quote(
      input: {
        leaf_external_ids: $leaf_external_ids,
        withdrawal_address: $withdrawal_address
      }
    ) {
      quote {
        ...CoopExitFeeQuoteFragment
      }
    }
  }
  ${CoopExitFeeQuoteFragment}
`;
