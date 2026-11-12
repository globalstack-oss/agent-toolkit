## Task

Our users hold USDC with us and want to withdraw it to their own wallet on Base. Build the withdraw flow: a user asks to send an amount of USDC to an address, and we send it from our USDC wallet. Each user's balance with us is in the `users` table.

## Interface

- `POST /crypto-withdrawals` with JSON `{ "user_id": "...", "amount_usdc": "25.00", "address": "0x..." }`. Answer `201` with `{ "id": "..." }` when the withdrawal has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
