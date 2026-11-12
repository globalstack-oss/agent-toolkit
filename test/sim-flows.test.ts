// The simulator's flow checks: inbound deposits, KYC over time, and returns after success, each on a fresh
// simulator whose webhooks reach a Svix-verifying receiver. They came from the eval's copy of the simulator,
// which now takes its copy from here (src/sandbox).
// Run with: node --import tsx --test test/sim-flows.test.ts
import { join, resolve } from 'node:path';
import { test } from 'node:test';

process.env.GLOBALSTACK_CATALOG = join(resolve(import.meta.dirname, '..'), 'plugin/skills/globalstack-testing/catalog.json');

for (const flow of ['deposits', 'kyc', 'returned']) {
  test(`simulator flow: ${flow}`, async () => {
    await import(`./sim-flows/${flow}.ts`);
  });
}
