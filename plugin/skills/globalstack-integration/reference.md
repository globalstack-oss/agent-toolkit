# GlobalStack reference

Lookup details for the rules in `SKILL.md`: formats, fields and tables. `scripts/gs.mjs build_guidance` returns
the topics that apply to a flow. For any other field, use `search_docs`.

## Failure reasons
Applies to: all

What each public `failure_reason` means, and whether to start again with a new quote and the next attempt number:

| `failure_reason` | Meaning | Start again? |
| --- | --- | --- |
| `temporarily_unavailable` | The provider was down or unreachable at execute | Yes |
| `quote_expired` | The payer did not pay, or the quote ran out, before the provider acted | Yes for money out; for money in, ask the payer to start again |
| `insufficient_funds` | Your wallet could not cover it | No. Fund the wallet, then start again |
| `failed` | The provider refused it (bad input, or no reason given) | No. Check the details |
| `cancelled`, `reversed` | The provider or the network cancelled or reversed it | No |
| `funding_failed` | An offramp's internal funding leg failed | No. Report it with the offramp id |
| `refund_failed` | The provider could not refund the payer | No. Report it |
| `returned` | Sent, then sent back (`SKILL.md` section 9) | No |

## Webhook amounts
Applies to: all

`destination_amount` is the quoted figure and can be before a fee: a ZAR offramp quoted at 110 can credit 100.
`received_amount` is what reached the recipient. On `success` events `actual_destination_amount` is also set;
`actual_source_amount` is not filled in today.

## Currency access
Applies to: all

`requires_access` marks a gated currency row for every merchant, and does not change after you get access. Your
own grant is `has_access` on the row (`GET /v1/currencies?code=XAF&country_code=CM`): `true` once approved. The
access request list (`GET /v1/currencies/access-requests`) shows your request's `status` (`pending`, `approved`,
`rejected`), for telling the user where it stands.

## KYC
Applies to: all

`POST /v1/customers/{customerId}/verifications` with `{ "tier": "tier_1", "redirect_url": "https://..." }` (both
optional) starts a verification. Send the customer to `hosted_url` from the answer. It stops working at
`hosted_url_expires_at`: start a new one after that. `GET /v1/customers/{customerId}/verifications` returns the
latest session. In `kyc.approved` and `kyc.rejected` events the customer is `event_object.customer.id`;
`event_object_id` is the verification session, not the customer.

## Crypto deposit addresses
Applies to: all

`POST /v1/wallets/{walletId}/deposit-addresses` with `{ network, label, metadata }` returns
`{ id, network, status, metadata, details: { address } }`. Each deposit to it is a transaction with
`type: deposit`, `source_type: deposit_address` and `source_id` = the address id.

## Onramp deposit instructions
Applies to: onramp

An onramp's `deposit_instruction` always has `version`, `type` and `expiresAt`.
- Bank (`type: fiat`): `accountName`, `accountNumber`, `bankName`, `bankCode`, and, when the provider gives one,
  `depositReference` with a `message`. The payer must quote that reference.
- Mobile money: `phoneNumber`, `providerId` and `instructions`. `expiresAt` is the quote's expiry.

## Payout account checks
Applies to: offramp

NGN and GHS bank accounts, KES mobile money and ZAR PayShap are checked with the provider when you create the
beneficiary. Other accounts are checked with the provider only when you create a quote, so wrong details show
up there.

## ZAR payout accounts
Applies to: offramp ZAR

- Bank account numbers are checked for format when you create the beneficiary, and again at quote: digits only,
  8 to 11 digits, and the exact length for the bank (Capitec and Nedbank 10, Standard Bank 9 or 11, Absa 8 to
  11, most others 11). Anything else returns `400 invalid_input` with a message to show the user.
- PayShap: send `rail: "payshap"`, `network: "bank"`, and a PayShap proxy in `account_number` (a mobile number in
  +E.164 form, or a ShapName such as `acme@nedbank`). On this rail `provider_id` and `account_name` are not
  needed: the bank that holds the proxy is found and its name is used.
- Names are converted to plain ASCII and cut to 30 characters.
