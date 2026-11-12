## Task

We pay freelancers in Kenya. Build the payout service: given a freelancer and an amount in KES they should receive, pay them to M-Pesa from our USDC wallet, and keep our payout records in sync (pending / paid / failed) using GlobalStack webhooks. Include the webhook receiver.

## Interface

- `POST /payouts` with JSON `{ "freelancer_id": "...", "amount_kes": "1500" }`. Answer `201` with `{ "id": "..." }` when the payout has started, or a `4xx` with `{ "error": "..." }` when it cannot start.
- `GET /payouts/:id` answers `{ "id": "...", "status": "pending" | "paid" | "failed" }`.
