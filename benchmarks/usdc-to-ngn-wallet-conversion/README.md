# usdc-to-ngn-wallet-conversion

USDC to the merchant's NGN wallet. Flow: conversion. Earlier id: T5.

Finance asks for an amount of NGN each morning; the app converts USDC so that exactly that NGN arrives in the NGN wallet, and keeps a record.

The agent gets [`task.md`](task.md) (the request and the HTTP routes the grader calls), [`schema.sql`](schema.sql) and the starter app [`starters/sqlite`](../starters/sqlite) (SQLite). [`reference/`](reference) is an app that passes every scenario.

## Scenarios (11)

Shared scenarios (see [the benchmarks README](../README.md#scenarios)): `happy-path`, `lost-response`, `crash`, `provider-error`, `rate-limit`, `webhook-noise`, `webhook-silence`, `combo-crash-silence`, `combo-lost-noisy`, `combo-provider-ratelimit`, `slow-truth`.

## Run

```bash
node --experimental-strip-types benchmarks/harness/check-references.ts --tasks usdc-to-ngn-wallet-conversion
```
