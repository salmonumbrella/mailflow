import { defineConfig } from 'vitest/config';
if (!process.env.MCP_CONTRACT_RESULTS) throw new Error('Native JSON report path required');
export default defineConfig({
  test: {
    include: ['src/routes/providerIdentities.mcpContract.test.js'],
    maxWorkers: 1, fileParallelism: false, pool: 'forks',
    testTimeout: 10000, hookTimeout: 10000,
    reporters: ['verbose', ['json', { outputFile: process.env.MCP_CONTRACT_RESULTS }]],
  },
});
