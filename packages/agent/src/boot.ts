// What the web app's server wiring (apps/web/src/lib/server/runtime.ts) needs on every request: the model factory and the help
// embedder. A separate entry from the package index, which also loads the turn workflow and the stream (`@ai-sdk/workflow`,
// `workflow`): a cold server read those on every page, about 0.2 s each time, for a feature only the assistant's routes use.
export { PolicyEmbedder } from "./runtime/embedder";
export { agentModelFactory } from "./runtime/mock-agent-model";
export { setAgentModelFactory } from "./runtime/policy-model";
