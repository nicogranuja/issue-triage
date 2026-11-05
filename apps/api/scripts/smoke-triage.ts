/**
 * Makes one real triage call to check credentials and the model end to end (`npm run
 * smoke:triage`). It costs a fraction of a cent, needs no database or GitHub access, and does
 * nothing unless credentials are set, so it is never run in CI.
 *
 *   ANTHROPIC_API_KEY=... npm run smoke:triage
 *   TRIAGE_PROVIDER=bedrock AWS_REGION=us-east-1 AWS_PROFILE=... npm run smoke:triage
 */
import { ConfigError, loadProcessConfig } from '../src/config.js';
import type { TriageInput } from '../src/triage/model.js';
import { PROMPT_VERSION } from '../src/triage/prompt.js';
import { createTriageModel } from '../src/triage/providers.js';

const input: TriageInput = {
  repository: 'lumen-labs/lumen',
  issue: {
    number: 42,
    title: 'PDF export fails for dashboards with an empty panel',
    body: "Steps to reproduce:\n\n1. Create a dashboard with one empty panel\n2. Click Export > PDF\n\nExpected a PDF. Got a 500 and `TypeError: cannot read properties of undefined (reading 'series')` in the server log.",
  },
  labels: [
    { name: 'bug', description: "Something isn't working" },
    { name: 'enhancement', description: 'New feature or request' },
    { name: 'area: export', description: 'PDF and PNG export' },
    { name: 'area: dashboards', description: null },
  ],
  candidates: [
    {
      number: 17,
      title: 'Exporting a dashboard to PDF crashes when a panel has no data',
      state: 'closed',
      excerpt: "Server log shows TypeError reading 'series' of undefined when exporting to PDF.",
    },
    {
      number: 23,
      title: 'Add CSV export for table panels',
      state: 'open',
      excerpt: 'It would be great to export the rows of a table panel as CSV.',
    },
  ],
};

function credentialsFor(provider: string): string | null {
  const env = process.env;
  if (provider === 'anthropic') {
    return env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY';
  }
  if (provider === 'bedrock') {
    const hasAws = env.AWS_BEARER_TOKEN_BEDROCK ?? env.AWS_ACCESS_KEY_ID ?? env.AWS_PROFILE;
    return hasAws
      ? null
      : 'AWS credentials (AWS_PROFILE, AWS_ACCESS_KEY_ID, or AWS_BEARER_TOKEN_BEDROCK)';
  }
  return 'a real provider (TRIAGE_PROVIDER=anthropic or bedrock)';
}

async function main(): Promise<void> {
  const { triage } = loadProcessConfig({ TRIAGE_PROVIDER: 'anthropic', ...process.env });
  const missing = credentialsFor(triage.provider);
  if (missing) {
    console.log(`Skipping the triage smoke test: set ${missing} to make one real call.`);
    return;
  }

  const model = await createTriageModel(triage);
  console.log(`Calling ${model.provider} (${model.modelId}, effort ${triage.effort})...`);
  const result = await model.suggest(input, {
    signal: AbortSignal.timeout(3 * triage.modelTimeoutMs),
  });
  console.log(JSON.stringify({ promptVersion: PROMPT_VERSION, ...result }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError || error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
