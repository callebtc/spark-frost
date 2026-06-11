import { FRAGMENT as TransferFragment } from "../objects/Transfer.js";
import { FRAGMENT as UserRequestFragment } from "../objects/UserRequest.js";

export const GetTransfers = `
  query Transfers($transfer_spark_ids: [UUID!]!) {
    transfers(transfer_spark_ids: $transfer_spark_ids) {
      ...TransferFragment
      transfer_user_request: user_request {
        ...UserRequestFragment
      }
    }
  }
  ${TransferFragment}
  ${UserRequestFragment}
`;
