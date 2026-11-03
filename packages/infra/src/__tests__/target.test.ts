import { describe, expect, it } from "vitest";
import { infra, POSTGRES_WORLD, target } from "../index";

// Rule 6 / design §21: one codebase, two targets. `ERP_TARGET` picks the cloud (Vercel) or the Docker implementation
// of every infra interface; nothing else in the code branches on where it runs.

describe("target()", () => {
  it("defaults to vercel when ERP_TARGET is unset or empty", () => {
    expect(target({})).toBe("vercel");
    expect(target({ ERP_TARGET: "" })).toBe("vercel");
  });

  it("reads ERP_TARGET", () => {
    expect(target({ ERP_TARGET: "vercel" })).toBe("vercel");
    expect(target({ ERP_TARGET: "docker" })).toBe("docker");
  });

  it("refuses any other value instead of guessing", () => {
    expect(() => target({ ERP_TARGET: "kubernetes" })).toThrow(/ERP_TARGET/);
  });

  it("reads the process environment by default", () => {
    const before = process.env.ERP_TARGET;
    process.env.ERP_TARGET = "docker";
    try {
      expect(target()).toBe("docker");
      expect(infra.target()).toBe("docker");
    } finally {
      if (before === undefined) delete process.env.ERP_TARGET;
      else process.env.ERP_TARGET = before;
    }
  });
});

describe("infra implementations by target", () => {
  const docker = {
    ERP_TARGET: "docker",
    WORKFLOW_TARGET_WORLD: POSTGRES_WORLD,
    WORKFLOW_POSTGRES_URL: "postgresql://postgres:secret@db:5432/postgres",
    SMTP_HOST: "mail",
    SMTP_PORT: "1025",
    MAIL_FROM: "erp@cafedelnorte.test",
    AI_GATEWAY_BASE_URL: "http://litellm:4000/v1",
    AI_GATEWAY_API_KEY: "local-key",
  };

  it("DurableRunner: the Vercel-managed world in the cloud, the Postgres World in Docker", () => {
    expect(infra.durableRunner({}).world).toBe("vercel");
    expect(infra.durableRunner(docker).world).toBe(POSTGRES_WORLD);
  });

  it("the Docker DurableRunner refuses to start without the Postgres World wiring", () => {
    expect(() => infra.durableRunner({ ERP_TARGET: "docker" })).toThrow(/WORKFLOW_TARGET_WORLD/);
    expect(() => infra.durableRunner({ ERP_TARGET: "docker", WORKFLOW_TARGET_WORLD: POSTGRES_WORLD })).toThrow(/WORKFLOW_POSTGRES_URL/);
  });

  it("Scheduler: phase 1 has only the tick; the cloud is driven by Vercel Cron, Docker by the worker's loop", async () => {
    let drained = 0;
    const drain = async () => ++drained;
    const cloud = infra.scheduler(drain, {});
    const local = infra.scheduler(drain, docker);
    expect(cloud.driver).toBe("vercel-cron");
    expect(local.driver).toBe("worker-loop");
    await expect(cloud.tick()).resolves.toEqual({ dispatched: 1 });
    await expect(local.tick()).resolves.toEqual({ dispatched: 2 });
  });

  it("ModelProvider: the AI Gateway in the cloud, a self-hosted gateway in Docker; never a model id", () => {
    expect(infra.modelProvider({ AI_GATEWAY_API_KEY: "k" }).gateway()).toEqual({ apiKey: "k" });
    expect(infra.modelProvider({}).gateway()).toEqual({});
    expect(infra.modelProvider(docker).gateway()).toEqual({ baseURL: "http://litellm:4000/v1", apiKey: "local-key" });
    expect(() => infra.modelProvider({ ERP_TARGET: "docker" }).gateway()).toThrow(/AI_GATEWAY_BASE_URL/);
  });

  it("Mailer: Resend in the cloud (its key from the environment), SMTP (Mailpit) in Docker", () => {
    expect(infra.mailer({ RESEND_API_KEY: "k", MAIL_FROM: "erp@cafedelnorte.co" }).transport).toBe("cloud");
    expect(() => infra.mailer({})).toThrow(/RESEND_API_KEY/);
    expect(infra.mailer(docker).transport).toBe("smtp");
    expect(() => infra.mailer({ ERP_TARGET: "docker" })).toThrow(/SMTP_HOST/);
  });

  it("FileStore: Supabase Storage on both targets (self-hosted Storage in Docker)", () => {
    const env = { SUPABASE_URL: "http://kong:8000", SUPABASE_SERVICE_ROLE_KEY: "service" };
    expect(infra.fileStore(env).constructor.name).toBe("SupabaseFileStore");
    expect(infra.fileStore({ ...env, ERP_TARGET: "docker" }).constructor.name).toBe("SupabaseFileStore");
  });
});
