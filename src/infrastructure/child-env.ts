const baseExactKeys = new Set(["CI", "COLORTERM", "FORCE_COLOR", "HOME", "LANG", "LOGNAME", "NO_COLOR", "PATH", "SHELL", "TEMP", "TERM", "TMP", "TMPDIR", "USER"]);
const basePrefixes = ["LC_", "XDG_"];
const providerExactKeys = new Set(["ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES", "ROADRUNNER_OPENCODE_DEBUG", "ROADRUNNER_PROVIDER_TIMEOUT_MS"]);
const providerPrefixes = ["ANTHROPIC_", "AWS_", "AZURE_", "COHERE_", "DEEPSEEK_", "GEMINI_", "GOOGLE_", "GROQ_", "MISTRAL_", "OLLAMA_", "OPENCODE_", "OPENAI_", "OPENROUTER_", "PERPLEXITY_", "TOGETHER_"];
const testProviderPrefixes = ["ROADRUNNER_FAKE_OPENCODE_", "ROADRUNNER_TEST_"];

export function providerChildEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...filterEnv(base, (key) => isBaseEnvKey(key) || isProviderEnvKey(base, key)), ...extra };
}

export function verificationChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return filterEnv(base, isBaseEnvKey);
}

function filterEnv(base: NodeJS.ProcessEnv, include: (key: string) => boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && include(key)) env[key] = value;
  }
  return env;
}

function isBaseEnvKey(key: string): boolean {
  return baseExactKeys.has(key) || basePrefixes.some((prefix) => key.startsWith(prefix));
}

function isProviderEnvKey(base: NodeJS.ProcessEnv, key: string): boolean {
  if (providerExactKeys.has(key)) return true;
  if (providerPrefixes.some((prefix) => key.startsWith(prefix))) return true;
  return (base.NODE_ENV === "test" || base.VITEST !== undefined) && testProviderPrefixes.some((prefix) => key.startsWith(prefix));
}
