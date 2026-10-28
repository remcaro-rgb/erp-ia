import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Signed download links live this long (design §5.13). */
export const SIGNED_URL_TTL_SECONDS = 60;

/** Bucket the attachments live in (migration 0007: private, readable only by the service role). */
export const ATTACHMENTS_BUCKET = "attachments";

/** Bucket the generated exports live in (migration 0016: private, readable only by the service role). */
export const EXPORTS_BUCKET = "exports";

/**
 * Where uploaded bytes live (rule 6): the cloud build uses Supabase Storage, the Docker build any
 * S3-compatible or on-disk implementation of the same interface. Business code depends on this
 * interface only.
 */
export interface FileStore {
  /** Stores the bytes at `path`; refuses to overwrite an existing object. */
  put(path: string, body: ReadableStream | Buffer, contentType: string): Promise<void>;
  /**
   * A link that downloads the object at `path` for `ttlSeconds`, then stops working. With `downloadName`
   * the browser saves it under that file name (the stored path is not the user's file name).
   */
  signedUrl(path: string, ttlSeconds: number, downloadName?: string): Promise<string>;
  /** Deletes the object (a no-op when it does not exist). */
  remove(path: string): Promise<void>;
  /** The object's bytes (server side: Workflows read the files they process). */
  get(path: string): Promise<Uint8Array>;
}

/**
 * Supabase Storage implementation, bucket `attachments` unless another is given (`exports`). It needs the service-role client: the bucket
 * has no policy for users, so it must only be created and used in route handlers and Workflows
 * (rule 12), never in the browser.
 */
export class SupabaseFileStore implements FileStore {
  constructor(
    private readonly client: Pick<SupabaseClient, "storage">,
    private readonly bucket: string = ATTACHMENTS_BUCKET,
  ) {}

  /** From `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, the server-side environment. */
  static fromEnv(env: Record<string, string | undefined> = process.env, bucket: string = ATTACHMENTS_BUCKET): SupabaseFileStore {
    const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SupabaseFileStore needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    return new SupabaseFileStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }), bucket);
  }

  async put(path: string, body: ReadableStream | Buffer, contentType: string): Promise<void> {
    // Files are capped at 25 MB, so a stream is read whole: the upload API takes bytes, not a half-duplex stream.
    const bytes = body instanceof ReadableStream ? Buffer.from(await new Response(body).arrayBuffer()) : body;
    const { error } = await this.client.storage.from(this.bucket).upload(path, bytes, { contentType, upsert: false });
    if (error) throw new Error(`could not store ${path}: ${error.message}`);
  }

  async signedUrl(path: string, ttlSeconds: number, downloadName?: string): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, ttlSeconds, downloadName === undefined ? undefined : { download: downloadName });
    if (error || !data) throw new Error(`could not sign ${path}: ${error?.message ?? "no url"}`);
    return data.signedUrl;
  }

  async remove(path: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([path]);
    if (error) throw new Error(`could not remove ${path}: ${error.message}`);
  }

  async get(path: string): Promise<Uint8Array> {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error || !data) throw new Error(`could not read ${path}: ${error?.message ?? "no data"}`);
    return new Uint8Array(await data.arrayBuffer());
  }
}
