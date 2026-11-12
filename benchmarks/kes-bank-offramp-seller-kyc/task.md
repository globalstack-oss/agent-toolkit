## Task

We run a marketplace in Kenya and pay our sellers in KES to their bank accounts, from our USDC wallet. Each seller must be their own GlobalStack customer and pass GlobalStack's identity verification (KYC) before we pay them anything. Build seller onboarding (create the seller at GlobalStack, start their verification, give them the verification link) and seller payouts, which must only go out once the seller's verification is approved. Seller details are in the `sellers` table.

## Interface

- `POST /sellers/:id/onboarding` (no body). Answer `201` with `{ "kyc_url": "https://..." }`, the link where the seller verifies their identity, or a `4xx` with `{ "error": "..." }`. Calling it again for the same seller returns their current link.
- `POST /sellers/:id/payouts` with JSON `{ "amount_kes": "15000" }`: the seller receives exactly this amount. Answer `201` with `{ "id": "..." }` when the payout has started, or a `4xx` with `{ "error": "..." }` when it cannot start, including when the seller's verification is not approved.
