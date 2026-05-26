import type { ProjectContext } from "../config.js";
import { defaultModel, defaultVariant } from "../../domain/provider-defaults.js";
import { OpenCodeProvider, validateOpenCodeCli } from "./opencode.js";
import type { Provider } from "./provider.js";

export type { Provider, ProviderRunInput, ProviderRunResult, ProviderStartEvent } from "./provider.js";

const providerRegistry = {
  opencode: {
    create: (context: ProjectContext) => new OpenCodeProvider({ model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant }),
    validate: validateOpenCodeCli,
  },
} satisfies Record<string, { create: (context: ProjectContext) => Provider; validate: () => Promise<string[]> }>;

export function providerFor(context: ProjectContext): Provider {
  return providerEntry(context).create(context);
}

export async function validateConfiguredProvider(context: ProjectContext): Promise<string[]> {
  const entry = providerRegistry[context.config.provider as keyof typeof providerRegistry];
  return entry ? entry.validate() : [`Unsupported provider: ${context.config.provider}`];
}

function providerEntry(context: ProjectContext): (typeof providerRegistry)[keyof typeof providerRegistry] {
  const entry = providerRegistry[context.config.provider as keyof typeof providerRegistry];
  if (!entry) throw new Error(`Unsupported provider: ${context.config.provider}`);
  return entry;
}
