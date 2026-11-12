## Task

We pay Nigerian suppliers from an NGN wallet at GlobalStack. Each morning finance asks for an amount of NGN to have available there. Build the top-up service: convert USDC from our USDC wallet into our NGN wallet so that exactly the requested NGN arrives, and keep a record finance can check. The NGN wallet id is in `GLOBALSTACK_NGN_WALLET_ID`.

## Interface

- `POST /ngn-topups` with JSON `{ "amount_ngn": "150000" }`. Answer `201` with `{ "id": "..." }` when the top-up has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
- `GET /ngn-topups/:id` answers `{ "id": "...", "status": "pending" | "completed" | "failed" }`.
