import { defaultModel, defaultVariant, type ProjectContext } from "../config.js";
import { OpenCodeProvider, validateOpenCodeCli } from "./opencode.js";
import type { Provider } from "./provider.js";

export type { Provider, ProviderRunInput, ProviderRunResult, ProviderStartEvent } from "./provider.js";

export function providerFor(context: ProjectContext): Provider {
  if (context.config.provider !== "opencode") throw new Error(`Unsupported provider: ${context.config.provider}`);
  return new OpenCodeProvider({ model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant });
}

export async function validateConfiguredProvider(context: ProjectContext): Promise<string[]> {
  if (context.config.provider !== "opencode") return [`Unsupported provider: ${context.config.provider}`];
  return validateOpenCodeCli();
}
