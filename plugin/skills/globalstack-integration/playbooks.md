# Flow playbooks

The steps for each flow, in order. `scripts/gs.mjs build_guidance` returns the playbook for your flow with the
`SKILL.md` sections it rests on. Each step names an action. Read actions are `scripts/gs.mjs` checks. Write actions
are API calls the merchant's code makes; never make them yourself:

| Step name | What to do |
| - | - |
| `list_supported_routes`, `get_transaction` | `node scripts/gs.mjs <name> '<json>'` now; the same `GET` call in the merchant code |
| `create_customer` | `POST /v1/customers`, then `POST /v1/customers/{id}/verifications` if KYC is needed |
| `create_beneficiary` | `POST /v1/beneficiaries` (`ensureBeneficiary` and `payeeReference` in `code/beneficiaries.ts`) |
| `request_currency_access` | `POST /v1/currencies/{code}/access-requests`, once, after the developer agrees |
| `create_quote` | `POST /v1/offramps/quotes`, `/v1/onramps/quotes` or `/v1/conversions/quotes` |
| `execute_offramp`, `execute_onramp` | `POST /v1/offramps` or `/v1/onramps`, through `createPayments` or `createCollections` |
| `manage_webhook` | `ensureWebhook` in `code/webhooks.ts` (create, then activate) |

Use `general` for a corridor with no playbook of its own.

When you write the merchant's code, the steps are also what that code must do each time a user
starts the flow: the route and access checks run in the request path, not once in a setup script.

## ngn_bank_withdraw: Pay out USDC to a Nigerian bank account

Route: offramp, NGN, NG, bank
Sections: 2, 4, 5, 6, 8, 10

Steps:
1. `list_supported_routes`: Check NGN bank offramp is open, in the request path.
2. `list_supported_routes`: Get provider_id with providers_for_country NG. Match the bank by name or code.
3. `create_customer`: Complete the profile first: phone, date of birth, ID number and type, address.
4. `create_beneficiary`: Pass customer_id, provider_id and a merchant_reference from payeeReference. Keep the beneficiary id and reuse it.
5. `create_beneficiary`: Show the user details.account_name: the bank sets the name for NGN.
6. `create_quote`: Offramp quote from the wallet. Read expires_at.
7. `execute_offramp`: Execute once with your reference. Never retry the same quote.
8. `get_transaction`: On an execute error, find the offramp by reference. If it failed or does not exist, retry from step 6 with the next attempt number, up to 3 attempts.

Traps:
- A 3-digit CBN bank code is not a provider_id.
- A 6-decimal balance must be rounded DOWN to 2 decimals. "Withdraw everything" uses available_balance.
- The NGN beneficiary name comes from the bank and cannot be changed later.

Smallest live test: the minimum amount to a Nigerian account you own.

## xaf_momo_topup: Top up USDC in Cameroon with XAF mobile money

Route: onramp, XAF, CM, mobile_money
Sections: 2, 3, 4, 7, 8, 10

Steps:
1. `list_supported_routes`: Check XAF in CM. It needs access: request it with country_code CM.
2. `request_currency_access`: Until approved, calls fail with 403 resource_access_required. Tell the user it is pending.
3. `create_customer`: Complete the profile first.
4. `create_quote`: Onramp quote: source_network mobile_money, provider_id, payer phone in +E.164, full_name.
5. `execute_onramp`: Execute starts the collection on the payer phone.

Traps:
- XAF has one row per country: always send country_code.
- The quote needs the operator's `provider_id`. Pick it from the payer's number, do not block the user:
  Orange is `+237 69x` and `+237 655` to `659`; MTN is the rest (`67x`, `650` to `654`, `68x`). Then
  `findProvider('CM', 'mobile_money', /orange/i or /mtn/i)`. A ported number can be wrong: let the user
  change the operator if the payment request does not reach their phone.
- requires_access stays true after you get access. The code checks `has_access` on the XAF/CM currency row each time a user starts a top-up, and says "pending" until it is true.
- A tier_0 customer's money-in counts against your merchant limit. Over the limit, the deposit is held, not lost.

Smallest live test: the minimum XAF amount from a phone you own.

## zar_bank_funding: Fund a USDC wallet by ZAR bank transfer

Route: onramp, ZAR, ZA, bank
Sections: 2, 3, 4, 7, 10

Steps:
1. `list_supported_routes`: Check ZAR bank onramp is open for this customer.
2. `create_customer`: Complete the profile first. A business needs its registration number.
3. `create_quote`: Onramp quote: source_currency ZAR, source_network bank.
4. `execute_onramp`: Show the payer the deposit_instruction, and when it expires.

Traps:
- The deposit instruction expires. A payment after `expiresAt` can fail. Show the expiry to the payer, and wait for the final status instead of failing the onramp yourself.
- ZAR can become gated. If the row shows requires_access, the code checks `has_access` on that row and handles 403 resource_access_required.
- A deposit over the tier limit arrives as deposit.held: tell the user, do not treat it as lost.

Smallest live test: the minimum ZAR amount from a bank account you own.

## kes_mpesa_payout: Pay out to M-Pesa in Kenya

Route: offramp, KES, KE, mobile_money
Sections: 2, 4, 6, 8, 10

Steps:
1. `list_supported_routes`: Check KES mobile money offramp is open. Get the M-Pesa provider_id.
2. `create_beneficiary`: network mobile_money. account_number is the phone. KES mobile money is checked at creation. merchant_reference from payeeReference.
3. `create_quote`: Use target_amount for "they should receive". Send exactly one of source_amount or target_amount.
4. `execute_offramp`: Execute once with your reference.
5. `get_transaction`: On an execute error, find the offramp by reference. If it failed or does not exist, retry from step 3 with the next attempt number, up to 3 attempts.
6. `manage_webhook`: Subscribe to offramp, save the signing_secret, then activate the endpoint.

Traps:
- A new webhook endpoint is inactive until you activate it.
- returned can follow success: keep listening after success.

Smallest live test: the minimum KES amount to an M-Pesa number you own.

## general: Any other corridor

Sections: 2, 3, 4, 5, 6, 8, 10

Steps:
1. `list_supported_routes`: Confirm the route is open and get provider_id.
2. `create_customer`: Complete the profile first.
3. `create_beneficiary`: Offramp only. Pass customer_id, provider_id and a merchant_reference from payeeReference.
4. `create_quote`: Read expires_at. Send exactly one of source_amount or target_amount.
5. `execute_offramp`: Or execute_onramp. Execute once with your own reference.
6. `get_transaction`: On an execute error, find the movement by reference. If it failed or does not exist, retry with a new quote (if any) and the next attempt number, up to 3 attempts. Refund only after the last one fails.
7. `manage_webhook`: Subscribe to the flow's category, save the signing_secret, then activate the endpoint.

Traps:
- Do not assume the corridor works because a similar one does. Check it on the live account.
- A transfer has no quote. If it answers 500, GlobalStack has already stored it as failed under that reference. Retry on your own with the next attempt number; do not fail it back to the user after one error.

Smallest live test: the minimum amount to an account you own.
