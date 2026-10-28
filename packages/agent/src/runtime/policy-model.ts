import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
// The serialization symbols from @workflow/serde (the same `Symbol.for` keys @ai-sdk/provider-utils re-exports): Next's
// Turbopack runs the Workflow transform only on files that import them from there (or carry a directive), and without it
// the step bundle never registers this class, so the model step could not rebuild the turn's model (Task 22 smoke).
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { gateway } from "ai";
import { providerOf, type ModelChoice } from "./model-policy";

// The turn's language model: the policy's choice (design §7.4, rule 26) as a serializable AI SDK model. The workflow
// creates it from the policy row its preparation step read; it crosses into the model step as plain data (primary and
// fallbacks) and resolves there through the AI Gateway, asking the gateway to fall back to the policy's other models
// in order on a provider error or rate limit. No model id lives in code: it always comes from `kernel.model_policies`.

/** Builds the language model for a gateway model id; the default is the AI Gateway's. */
export type ModelFactory = (modelId: string) => LanguageModelV4;

// Kept on globalThis: the model step runs from the workflow's step bundle, which loads this module a second time.
const FACTORY_KEY = Symbol.for("erp.agent.modelFactory");
const globals = globalThis as { [FACTORY_KEY]?: ModelFactory };

/**
 * Replaces how a gateway model id becomes a model (`undefined` restores the gateway). For tests, which install the AI
 * SDK mock model; the model id the policy chose is still what is metered.
 */
export function setAgentModelFactory(factory: ModelFactory | undefined): void {
  globals[FACTORY_KEY] = factory;
}

/** The factory installed with `setAgentModelFactory`, if any. */
export function installedAgentModelFactory(): ModelFactory | undefined {
  return globals[FACTORY_KEY];
}

const languageModel = (modelId: string): LanguageModelV4 => (globals[FACTORY_KEY] ?? ((id: string) => gateway.languageModel(id)))(modelId);

export class PolicyModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider: string;
  readonly modelId: string;
  readonly fallbacks: string[];

  static [WORKFLOW_SERIALIZE](model: PolicyModel): ModelChoice {
    return { primary: model.modelId, fallbacks: model.fallbacks };
  }

  static [WORKFLOW_DESERIALIZE](choice: ModelChoice): PolicyModel {
    return new PolicyModel(choice);
  }

  constructor(choice: ModelChoice) {
    this.modelId = choice.primary;
    this.provider = providerOf(choice.primary);
    this.fallbacks = [...choice.fallbacks];
  }

  // URLs are downloaded rather than passed through: the assistant sends no files in phase 1.
  get supportedUrls(): Record<string, RegExp[]> {
    return {};
  }

  private options(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
    const gatewayOptions = (options.providerOptions?.gateway ?? {}) as Record<string, unknown>;
    return { ...options, providerOptions: { ...options.providerOptions, gateway: { ...gatewayOptions, models: this.fallbacks } as never } };
  }

  doGenerate(options: LanguageModelV4CallOptions) {
    return languageModel(this.modelId).doGenerate(this.options(options));
  }

  doStream(options: LanguageModelV4CallOptions) {
    return languageModel(this.modelId).doStream(this.options(options));
  }
}

/** The model of a policy choice. A plain function, so the workflow never writes `new` in its own closure. */
export function policyModel(choice: ModelChoice): PolicyModel {
  return new PolicyModel(choice);
}
