import { defineTool } from './types';

export const getGsAccountInfo = defineTool({
  name: 'get_gs_account_info',
  title: 'Check the API key',
  description:
    'Checks that the Global Stack API key works and returns the integration and role it acts as. Call this first.',
  group: 'read',
  calls: [{ method: 'GET', path: '/v1/me' }],
  inputSchema: {},
  async run(_args, api) {
    return api.request('GET', '/v1/me');
  },
});
