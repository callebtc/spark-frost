import { FRAGMENT as LightningSendFeeEstimateOutputFragment } from "../objects/LightningSendFeeEstimateOutput.js";

export const LightningSendFeeEstimate = `
  query LightningSendFeeEstimate(
    $encoded_invoice: String!
    $amount_sats: Long
  ) {
    lightning_send_fee_estimate(
      input: {
        encoded_invoice: $encoded_invoice
        amount_sats: $amount_sats
      }
    ) {
      ...LightningSendFeeEstimateOutputFragment
    }
  }
  ${LightningSendFeeEstimateOutputFragment}
`;
