import type { FileStore } from "@erp/infra";

// The file store kernel code reads and writes through (rule 6: the interface, never a provider API): the cloud
// build's Supabase Storage from the server environment unless something else was installed (the Docker build's
// store, or a test's in-memory one). Kept on globalThis: the workflow step bundle loads this module a second time
// and must see the store the app installed.

const GLOBAL_KEY = Symbol.for("erp.kernel.fileStore");
const globals = globalThis as { [GLOBAL_KEY]?: FileStore };

/** Installs the store kernel code uses; `undefined` goes back to the default. */
export function setFileStore(store: FileStore | undefined): void {
  globals[GLOBAL_KEY] = store;
}

/**
 * The installed store, or Supabase Storage from `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (service role, server
 * side only). The provider is loaded on first use only, so a worker that installed its own store never loads it.
 */
export async function fileStore(): Promise<FileStore> {
  const installed = globals[GLOBAL_KEY];
  if (installed) return installed;
  const { SupabaseFileStore } = await import("@erp/infra");
  return (globals[GLOBAL_KEY] ??= SupabaseFileStore.fromEnv());
}

// The generated exports live in their own bucket (`exports`, migration 0016), behind the same interface.
const EXPORTS_KEY = Symbol.for("erp.kernel.exportsStore");
const exportGlobals = globalThis as { [EXPORTS_KEY]?: FileStore };

/** Installs the store the export workflow writes to and the download link is signed from; `undefined` goes back to the default. */
export function setExportsStore(store: FileStore | undefined): void {
  exportGlobals[EXPORTS_KEY] = store;
}

/** The installed exports store, or Supabase Storage's bucket `exports` from the server environment (service role). */
export async function exportsStore(): Promise<FileStore> {
  const installed = exportGlobals[EXPORTS_KEY];
  if (installed) return installed;
  const { SupabaseFileStore, EXPORTS_BUCKET } = await import("@erp/infra");
  return (exportGlobals[EXPORTS_KEY] ??= SupabaseFileStore.fromEnv(process.env, EXPORTS_BUCKET));
}

/** An in-memory store for tests: same contract, nothing leaves the process. */
export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(path: string, body: ReadableStream | Buffer, contentType: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`could not store ${path}: The resource already exists`);
    const bytes = body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array(body);
    this.files.set(path, { bytes, contentType });
  }

  async signedUrl(path: string, ttlSeconds: number): Promise<string> {
    if (!this.files.has(path)) throw new Error(`could not sign ${path}: not found`);
    return `memory://${path}?ttl=${ttlSeconds}`;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async get(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`could not read ${path}: not found`);
    return file.bytes;
  }
}
