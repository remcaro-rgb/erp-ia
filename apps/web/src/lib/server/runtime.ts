import { core } from "@erp/module-core";
import { co } from "@erp/loc-co";
import { getServiceDb, kernelModule, loadModules, registerCountryPack, registry, type RunProcessDeps } from "@erp/kernel";
import { SupabaseFileStore, type FileStore } from "@erp/infra";

// Server-side wiring for route handlers: the process registry with the modules this app ships, the
// service database connection `runProcess` works through, and the file store. Task 10 grows it.

/** Dependencies for `runProcess`; loads the modules into the registry and the country packs on first use. */
export function processDeps(): RunProcessDeps {
  if (!registry.hasModule(kernelModule.id)) loadModules(registry, [kernelModule, core]);
  // The core processes validate parties and products with the company's pack (rule 5). Registered on every call:
  // the registry lives on globalThis, the pack table in its module, which a bundle may load more than once.
  registerCountryPack(co);
  return { sql: getServiceDb(), registry };
}

let store: FileStore | undefined;

/** The attachments file store (Supabase Storage, service role). */
export function fileStore(): FileStore {
  store ??= SupabaseFileStore.fromEnv();
  return store;
}
