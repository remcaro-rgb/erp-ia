import { required, type Env } from "./target";

// Where model calls go (rule 26, design §7.4 and §21). Only the gateway's address and key differ by target; which
// model answers which task stays in `kernel.model_policies`, never here.
//  - vercel: the Vercel AI Gateway (the AI SDK default; `AI_GATEWAY_API_KEY`, or the deployment's OIDC token);
//  - docker: a self-hosted, gateway-compatible endpoint on the customer's network (`AI_GATEWAY_BASE_URL`, e.g. LiteLLM)
//    with its key.
// Phase 1 exposes the configuration; the agent's gateway factory (packages/agent policy-model.ts) reads it when the
// on-premise build is delivered (phase 6).

export interface GatewayConfig {
  /** Unset: the AI SDK's default gateway URL. */
  baseURL?: string;
  apiKey?: string;
}

export interface ModelProvider {
  gateway(): GatewayConfig;
}

export function cloudModelProvider(env: Env = process.env): ModelProvider {
  return {
    gateway: () => (env.AI_GATEWAY_API_KEY ? { apiKey: env.AI_GATEWAY_API_KEY } : {}),
  };
}

export function dockerModelProvider(env: Env = process.env): ModelProvider {
  return {
    gateway: () => {
      const baseURL = required(env, "AI_GATEWAY_BASE_URL", "for ERP_TARGET=docker (the self-hosted model gateway)");
      return env.AI_GATEWAY_API_KEY ? { baseURL, apiKey: env.AI_GATEWAY_API_KEY } : { baseURL };
    },
  };
}
