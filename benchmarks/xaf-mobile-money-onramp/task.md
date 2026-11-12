## Task

Our users in Cameroon want to top up their USDC balance by paying in XAF with mobile money (MTN MoMo / Orange Money). Build the backend flow: start a top-up for a user, show them payment instructions, and credit their USDC balance when the money arrives. The USDC lands in our USDC wallet; each user's balance with us is in the `users` table.

## Interface

- `POST /topups` with JSON `{ "user_id": "...", "amount_xaf": "5000", "phone": "+2376..." }`. Answer `201` with `{ "id": "...", "instructions": "..." }` when the top-up has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
