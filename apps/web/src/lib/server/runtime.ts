import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { sales } from "@erp/module-sales";
import { inventory } from "@erp/module-inventory";
import { support } from "@erp/module-support";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { agentModelFactory, PolicyEmbedder, setAgentModelFactory } from "@erp/agent/boot";
import { translate } from "@erp/i18n";
import { FakeEmbedder, getServiceDb, installedHelpEmbedder, kernelModule, loadModules, registerCatalogue, registerCountryPack, registry, secretStore, setHelpEmbedder, setSecretStore, syncRegistry, type RunProcessDeps } from "@erp/kernel";
import { SupabaseFileStore, VaultSecretStore, type FileStore } from "@erp/infra";

// Server-side wiring for route handlers: the process registry with the modules this app ships, the
// service database connection `runProcess` works through, and the file store. Task 10 grows it.

/** Dependencies for `runProcess`; loads the modules into the registry and the country packs on first use. */
export function processDeps(): RunProcessDeps {
  if (!registry.hasModule(kernelModule.id)) loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments]);
  // The core processes validate parties and products with the company's pack (rule 5). Registered on every call:
  // the registry lives on globalThis, the pack table in its module, which a bundle may load more than once.
  // With its electronic-invoicing entry (server-only: numbering by the DIAN resolution and the CUFE, plan 2B Task 16).
  registerCountryPack({ ...co, einvoice: einvoicePack });
  // What the kernel prints outside a screen (PDF templates: labels, page numbers) reads the app's catalogue (rule 24).
  registerCatalogue(translate);
  installAgentModel();
  installSecretStore();
  // The help search embeds questions with the model the policy table names for `embeddings` (rule 26), unless
  // something (a test) installed its own embedder. With the mock model (same opt-in, same production guard) there is no
  // gateway: the deterministic embedder `pnpm help:index` uses without a key.
  if (!installedHelpEmbedder()) setHelpEmbedder(agentModelFactory(process.env) ? new FakeEmbedder() : new PolicyEmbedder(getServiceDb()));
  return { sql: getServiceDb(), registry };
}

/**
 * The secret store of the DIAN certificate and the software PIN (rule 12; plan 2B Task 19): Supabase Vault through migration 0099's
 * service-role wrappers, on the server's service connection, installed when the deployment configures the Supabase service role. Without it
 * no store is installed: the certificate upload is refused and the real DIAN transports cannot be built (they need a store injected; the
 * mock, the default of CI and Docker, needs none). Something already installed (a test's store) is kept.
 */
function installSecretStore(): void {
  if (secretStore() || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return;
  setSecretStore(new VaultSecretStore(getServiceDb()));
}

const MODEL_KEY = Symbol.for("erp.web.agentModelInstalled");
const modelGlobals = globalThis as { [MODEL_KEY]?: boolean };

/**
 * The assistant's model (design §7.4): `AGENT_MODEL=mock` installs the AI SDK mock model (end-to-end tests, a local stack
 * without a gateway key; in production only with ALLOW_MOCK_MODEL=1, the Docker test stack); otherwise the turn's model resolves through the AI Gateway (AI_GATEWAY_API_KEY). Once per
 * server process, at boot (instrumentation) and before any turn; the factory lives on globalThis, where the workflow's
 * model step reads it.
 */
export function installAgentModel(): void {
  if (modelGlobals[MODEL_KEY]) return;
  // Throws on a production server with AGENT_MODEL=mock and no ALLOW_MOCK_MODEL=1: at boot (instrumentation) and on
  // every request after, never silently falling back to another model.
  const factory = agentModelFactory(process.env);
  modelGlobals[MODEL_KEY] = true;
  if (!factory) return;
  setAgentModelFactory(factory);
  console.warn("assistant: AGENT_MODEL=mock, the turns run with the AI SDK mock model (no gateway, metered as mock/agent)");
}

// The manifests registered in SQL once per server process (design §5.2: at boot): the role seeds and the admin
// processes read the processes and the confidential fields from kernel.registered_processes / kernel.entity_fields.
const SYNC_KEY = Symbol.for("erp.web.registrySynced");
const syncGlobals = globalThis as { [SYNC_KEY]?: Promise<void> };

/** Resolves once this process registered the loaded modules' manifests (a failure is retried on the next call). */
export function registrySynced(): Promise<void> {
  const deps = processDeps();
  syncGlobals[SYNC_KEY] ??= syncRegistry(deps.sql, deps.registry).catch((error: unknown) => {
    syncGlobals[SYNC_KEY] = undefined;
    throw error;
  });
  return syncGlobals[SYNC_KEY];
}

let store: FileStore | undefined;

/** The attachments file store (Supabase Storage, service role). */
export function fileStore(): FileStore {
  store ??= SupabaseFileStore.fromEnv();
  return store;
}
