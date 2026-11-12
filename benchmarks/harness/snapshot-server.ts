// The account as the MCP arm sees it while building: the simulator seeded like the real account
// (XAF access still pending), answering GET requests only. Writes are refused.
import { fileURLToPath } from 'node:url';
import { Sim } from '../../src/sandbox/sim.ts';

/** The simulator reads the plugin's catalog when a Sim is built. */
process.env.GLOBALSTACK_CATALOG ??= fileURLToPath(new URL('../../plugin/skills/globalstack-testing/catalog.json', import.meta.url));

export async function startSnapshotServer(secretKey: string): Promise<{ url: string; close: () => Promise<void> }> {
  const sim = new Sim({ secretKey, xafAccess: 'pending' });
  sim.http.readOnly = true;
  const url = await sim.listen(0);
  return { url, close: () => sim.close() };
}
