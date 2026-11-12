## Task

Our South African business customers want to fund their USDC wallet with us by paying ZAR from their bank account. Build the backend flow: start a funding request, give them the bank details to pay, and credit their USDC when the money arrives. The USDC lands in our USDC wallet; each business's balance with us is in the `businesses` table.

## Interface

- `POST /fundings` with JSON `{ "business_id": "...", "amount_zar": "1000.00" }`. Answer `201` with `{ "id": "...", "bank_details": { ... } }` when the request has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
