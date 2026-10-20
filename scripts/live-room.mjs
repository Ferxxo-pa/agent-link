import { createProviderFromEnv } from '../provider.mjs';
import { runTwoAgentScenario } from '../scenario.mjs';

// Same two-host flow as the offline test. Skips cleanly when no provider key is configured.
if (!process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY) {
  console.log('No XAI_API_KEY or OPENAI_API_KEY in the environment. Live room skipped.');
  process.exit(0);
}
if (process.env.AGENT_LINK_PROVIDER === 'offline') {
  console.log('AGENT_LINK_PROVIDER=offline. Live room skipped.');
  process.exit(0);
}

const provider = createProviderFromEnv();
console.log(`Live room using ${provider.name} model ${provider.model || 'offline'}`);
const result = await runTwoAgentScenario({
  providerFor: () => provider,
  live: true,
  pollMs: 1000,
  stepTimeout: 90000,
  quietMs: 3000,
  maxTurns: 8,
  maxTokens: 40000,
  maxConsecutiveAgentTurns: 3
});
console.log(JSON.stringify({ ok: true, alice: result.alice.reason, bob: result.bob.reason, aliceTurns: result.alice.turns, bobTurns: result.bob.turns }));
