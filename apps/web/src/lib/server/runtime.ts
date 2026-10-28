import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { co } from "@erp/loc-co";
import { PolicyEmbedder } from "@erp/agent";
import { getServiceDb, installedHelpEmbedder, kernelModule, loadModules, registerCountryPack, registry, setHelpEmbedder, syncRegistry, type RunProcessDeps } from "@erp/kernel";
import { SupabaseFileStore, type FileStore } from "@erp/infra";

// Server-side wiring for route handlers: the process registry with the modules this app ships, the
// service database connection `runProcess` works through, and the file store. Task 10 grows it.

/** Dependencies for `runProcess`; loads the modules into the registry and the country packs on first use. */
export function processDeps(): RunProcessDeps {
  if (!registry.hasModule(kernelModule.id)) loadModules(registry, [kernelModule, core, support]);
  // The core processes validate parties and products with the company's pack (rule 5). Registered on every call:
  // the registry lives on globalThis, the pack table in its module, which a bundle may load more than once.
  registerCountryPack(co);
  // The help search embeds questions with the model the policy table names for `embeddings` (rule 26), unless
  // something (a test) installed its own embedder.
  if (!installedHelpEmbedder()) setHelpEmbedder(new PolicyEmbedder(getServiceDb()));
  return { sql: getServiceDb(), registry };
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
