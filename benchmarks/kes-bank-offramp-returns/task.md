## Task

We hold USDC for our users and they want to withdraw to their Kenyan bank accounts. Build the withdraw flow: a user asks to withdraw an amount of USDC, we debit their balance and pay it out in KES to their bank. Kenyan bank payments can bounce back days after they went through; when that happens the user must get their USDC back. The USDC comes from our USDC wallet; each user's balance with us and bank details are in the `users` table.

## Interface

- `POST /withdrawals` with JSON `{ "user_id": "...", "amount_usdc": "50.00" }`. Answer `201` with `{ "id": "..." }` when the withdrawal has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
