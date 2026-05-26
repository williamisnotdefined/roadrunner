const baseExactKeys = new Set(["CI", "COLORTERM", "FORCE_COLOR", "HOME", "LANG", "LOGNAME", "NO_COLOR", "PATH", "SHELL", "TEMP", "TERM", "TMP", "TMPDIR", "USER"]);
const basePrefixes = ["LC_", "XDG_"];
const providerPrefixes = ["ANTHROPIC_", "AWS_", "AZURE_", "COHERE_", "DEEPSEEK_", "GEMINI_", "GOOGLE_", "GROQ_", "MISTRAL_", "OLLAMA_", "OPENCODE_", "OPENAI_", "OPENROUTER_", "PERPLEXITY_", "ROADRUNNER_", "TOGETHER_"];

export function providerChildEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...filterEnv(base, (key) => isBaseEnvKey(key) || providerPrefixes.some((prefix) => key.startsWith(prefix))), ...extra };
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
