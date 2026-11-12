## Task

We hold USDC for our users and they want to withdraw to their Nigerian bank accounts. Build the withdraw flow: a user asks to withdraw an amount of USDC (or "withdraw everything"), and we pay it out in NGN to their bank. The USDC comes from our USDC wallet; each user's balance with us and bank details are in the `users` table.

## Interface

- `POST /withdrawals` with JSON `{ "user_id": "...", "amount": "50.00" }` or `{ "user_id": "...", "amount": "all" }`. Answer `201` with `{ "id": "..." }` when the withdrawal has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
