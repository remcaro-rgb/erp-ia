import { cloudDurableRunner, dockerDurableRunner, type DurableRunner } from "./durable-runner";
import { ATTACHMENTS_BUCKET, SupabaseFileStore, type FileStore } from "./file-store";
import { cloudMailer, dockerMailer, type Mailer } from "./mailer";
import { cloudModelProvider, dockerModelProvider, type ModelProvider } from "./model-provider";
import { tickScheduler, type Scheduler } from "./scheduler";
import { target, type Env } from "./target";

export { ATTACHMENTS_BUCKET, EXPORTS_BUCKET, SIGNED_URL_TTL_SECONDS, SupabaseFileStore } from "./file-store";
export type { FileStore } from "./file-store";
export { SupabaseAuthAdmin } from "./auth-admin";
export type { AuthAdmin, SessionRevoker } from "./auth-admin";
export { cloudDurableRunner, dockerDurableRunner, POSTGRES_WORLD } from "./durable-runner";
export type { DurableRunner, DurableRunStatus } from "./durable-runner";
export { MAX_BACKOFF_MS, runEvery, tickScheduler } from "./scheduler";
export type { Scheduler, TickResult } from "./scheduler";
export { cloudModelProvider, dockerModelProvider } from "./model-provider";
export type { GatewayConfig, ModelProvider } from "./model-provider";
export { cloudMailer, dockerMailer, encodeHeader, MailIdempotencyError, ResendMailer, SmtpMailer } from "./mailer";
export type { MailAttachment, MailMessage, Mailer, MailResult, ResendOptions, SmtpOptions } from "./mailer";
export { EInvoiceTransportError, MockEInvoiceTransport, mockTrackId, resetMockEInvoiceState } from "./einvoice-transport";
export type { EInvoiceResult, EInvoiceStatus, EInvoiceSubmitMeta, EInvoiceTransport, MockEInvoiceOptions, MockScenario } from "./einvoice-transport";
export { EnvSecretStore, InMemorySecretStore, VaultSecretStore } from "./secret-store";
export type { SecretSql, SecretStore } from "./secret-store";
export { fixtureRateFeed, httpRateFeed, RATE_FEED_TIMEOUT_MS, rateFeedFixtureName, rateFeedFromEnv } from "./rate-feed";
export type { RateFeed } from "./rate-feed";
export { target } from "./target";
export type { Env, Target } from "./target";

/**
 * The platform seams of rule 6, each with its cloud (`vercel`) and Docker implementation chosen by `ERP_TARGET`
 * (design §21). Business code takes these interfaces; only a process's wiring (the web runtime, the worker) calls
 * the factories.
 */
export const infra = {
  target,
  durableRunner(env: Env = process.env): DurableRunner {
    return target(env) === "docker" ? dockerDurableRunner(env) : cloudDurableRunner();
  },
  /** Phase 1 schedules one job, the outbox tick (`drain` is `drainOutbox` bound to its connection). */
  scheduler(drain: () => Promise<number>, env: Env = process.env): Scheduler {
    return tickScheduler(target(env) === "docker" ? "worker-loop" : "vercel-cron", drain);
  },
  modelProvider(env: Env = process.env): ModelProvider {
    return target(env) === "docker" ? dockerModelProvider(env) : cloudModelProvider(env);
  },
  mailer(env: Env = process.env): Mailer {
    return target(env) === "docker" ? dockerMailer(env) : cloudMailer(env);
  },
  /** Supabase Storage on both targets: hosted in the cloud, the self-hosted Storage service in Docker. */
  fileStore(env: Env = process.env, bucket: string = ATTACHMENTS_BUCKET): FileStore {
    return SupabaseFileStore.fromEnv(env, bucket);
  },
};
