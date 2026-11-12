## Task

hey! our users in South Africa keep asking if they can cash out their USDC to their bank accounts. can you add that? their bank details and USDC balances are already in the `users` table.

## Interface

- `POST /cashouts` with JSON `{ "user_id": "...", "amount_usdc": "40.00" }`. Answer `201` with `{ "id": "..." }` when the cash-out has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
