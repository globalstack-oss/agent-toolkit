## Task

Our users want to add USDC to their balance with us by sending it on Base from their own wallets or exchanges. Give each user their own USDC deposit address on Base, and credit their USDC balance when a deposit to that address is confirmed. The USDC lands in our USDC wallet; each user's balance with us is in the `users` table.

## Interface

- `POST /deposit-addresses` with JSON `{ "user_id": "..." }`. Answer `201` with `{ "address": "0x..." }`, the user's deposit address, or a `4xx` with `{ "error": "..." }` when you cannot give one. Asking again for the same user returns the same address.
