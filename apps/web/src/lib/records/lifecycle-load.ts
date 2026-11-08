import { runnableProcesses, withClaims, type Caller, type EntityDef, type FieldDef } from "@erp/kernel";
import type { LifecycleFlags, RecordStatus } from "@erp/kernel/lifecycle";
import { unreadableOrderIds } from "@/lib/sales/order-owner";
import { processDeps } from "@/lib/server/runtime";

// What the record frame's action bar, Versiones and Acceso need of a maestro or documento (Task 15). Rights = the processes the
// caller may run ∩ the record's access rules (kernel.can_access_record; never narrows an admin) ∩ the menu (an item hidden from the
// caller hides its record's buttons too). Every one of them is checked again by the process that runs (hiding is never the guard).

const STATUSES: readonly RecordStatus[] = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];
/** What a masked value shows in Versiones (D18), in both versions, never marked as changed. */
export const MASKED = "••••••••";
/** Row columns that Versiones never compares: plumbing, not data. */
const PLUMBING = new Set(["id", "company_id", "seq", "created_at", "updated_at", "created_by", "updated_by", "deleted_at", "requires_approval", "posts", "status", "extra", "extra_free", "chain_id"]);

export interface LifecycleRights {
  modify: boolean;
  submit: boolean;
  delete: boolean;
  void: boolean;
  approve: boolean;
  reject: boolean;
}

export interface SnapshotView {
  version: number;
  status: RecordStatus;
  at: string;
  by: string | null;
  reason: string | null;
  header: Record<string, string>;
  lines: Record<string, string>[];
}

export interface AccessView {
  grants: { kind: "role" | "user"; id: string; name: string; rights: string[] }[];
  options: { kind: "role" | "user"; id: string; name: string }[];
}

export interface LoadedLifecycle {
  entityType: "maestro" | "documento";
  status: RecordStatus;
  flags: LifecycleFlags;
  rights: LifecycleRights;
  /** The tools on the left of the bar. */
  tools: { new: boolean; print: boolean; notify: boolean };
  /** The entity's grid (Eliminar leaves to it). */
  listHref: string;
  updatedAt: string | null;
  createdAt: string | null;
  updatedAtText: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  /** The addresses of the current status's list (Notificar's prefill). */
  recipients: string[];
  /** Documentos: the versions (masked for the viewer, D18); null for a maestro. */
  snapshots: SnapshotView[] | null;
  /** Field labels of the compared header and lines columns, by name. */
  versionLabels: { header: Record<string, string>; lines: Record<string, string> };
  /** Admins: the record's access rules and who can get one; null for anyone else. */
  access: AccessView | null;
  /**
   * The question the void's reason row adds (plan 2B.2 Task 43, R43-7): only a shipped entrega, not yet voided, whose pedido is not cancelled
   * offers «¿Reservar de nuevo las existencias para el pedido?», ticked by default. Absent for every other record.
   */
  voidOption?: { label: string; defaultChecked: boolean };
}

type Translate = (key: string) => string;

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : typeof value === "string" && value ? value : null);

/** The lifecycle facts of `record` of the typed entity `entity`, or null when the entity is not a maestro or documento. */
export async function loadLifecycle(caller: Caller, entity: EntityDef, record: (Record<string, unknown> & { id: string }) | null, modes: Record<string, string>, t: Translate, canSave: boolean): Promise<LoadedLifecycle | null> {
  const entityType = entity.entityType;
  if (entityType !== "maestro" && entityType !== "documento") return null;
  const deps = processDeps();
  const verbs = ["save", "submit", "approve", "reject", "void", "delete"].map((v) => `${entity.id}.${v}`);
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, [...verbs, entity.processIds?.create ?? `${entity.id}.create`, "kernel.doc_template.print", "kernel.record.notify", "kernel.record_access.set"].filter((p): p is string => !!p));
  const linesEntity = entity.typed?.lines ? deps.registry.entity(entity.typed.lines.entity) : null;

  const facts = await withClaims(deps.sql, caller.claims, async (tx) => {
    const [admin] = await tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
    // The entity's menu item: where Eliminar leaves to, and whether the caller's menu access keeps it (Task 10; never narrows an admin).
    const [menu] = await tx<{ href: string; allowed: boolean }[]>`
      select href, kernel.menu_path_allowed(href) as allowed from kernel.menu_items where entity = ${entity.id} and href is not null order by nav_key limit 1`;
    const status = (STATUSES as readonly string[]).includes(String(record?.status ?? "")) ? (record!.status as RecordStatus) : "draft";
    let flags: LifecycleFlags;
    if (record && typeof record.requires_approval === "boolean") flags = { requiresApproval: record.requires_approval, posts: record.posts === true };
    else {
      const [row] = await tx<{ requires_approval: boolean; posts: boolean }[]>`
        select requires_approval, posts from kernel.entity_type_settings where company_id = ${caller.claims.active_company_id} and entity = ${entity.id}`;
      flags = { requiresApproval: row?.requires_approval === true, posts: entityType === "documento" && (row?.posts ?? record?.posts === true) };
      if (record && typeof record.posts === "boolean") flags.posts = record.posts;
    }
    const access = record
      ? (
          await tx<{ modify: boolean; delete: boolean; void: boolean }[]>`
            select kernel.can_access_record(${entity.id}, ${record.id}::uuid, 'modify') as modify,
                   kernel.can_access_record(${entity.id}, ${record.id}::uuid, 'delete') as delete,
                   kernel.can_access_record(${entity.id}, ${record.id}::uuid, 'void') as void`
        )[0]!
      : { modify: true, delete: true, void: true };
    // The footer's authors: the views do not carry created_by / updated_by (kernel.record_authors, 0050).
    const [authors] = record ? await tx<{ created_by_name: string | null; updated_by_name: string | null }[]>`select * from kernel.record_authors(${entity.id}, ${record.id}::uuid)` : [];
    // Minor m5: the configured state recipients are external addresses only a company admin sees (RLS, 0052); Notificar prefills them for an admin only.
    const recipients = record && admin?.admin === true
      ? ((await tx<{ emails: string[] }[]>`select emails from kernel.state_recipients where company_id = ${caller.claims.active_company_id} and entity = ${entity.id} and status = ${status}`)[0]?.emails ?? [])
      : [];
    // D18 in SQL (rule 14, 0051): kernel.record_versions answers the snapshots with what the viewer may not see already masked; the
    // raw payload never reaches this server.
    const snapshots =
      record && entityType === "documento"
        ? await tx<{ version: string; status: RecordStatus; header: Record<string, unknown>; lines: Record<string, unknown>[]; reason: string | null; created_at: Date; by_name: string | null }[]>`
            select version, status, header, lines, reason, created_at, by_name from kernel.record_versions(${entity.id}, ${record.id}::uuid)`
        : null;
    const headerNames = entity.fields.filter((f) => !PLUMBING.has(f.name)).map((f) => f.name);
    const lineNames = linesEntity ? linesEntity.fields.filter((f) => !PLUMBING.has(f.name) && f.name !== entity.typed!.lines!.parentField).map((f) => f.name) : [];
    let accessView: AccessView | null = null;
    if (record && admin?.admin && runnable.has("kernel.record_access.set")) {
      const [grants, roles, users] = await Promise.all([
        tx<{ role_id: string | null; user_id: string | null; name: string | null; can_read: boolean; can_use: boolean; can_modify: boolean; can_delete: boolean; can_void: boolean }[]>`
          select ra.grantee_role_id as role_id, ra.grantee_user_id as user_id, coalesce(r.name, u.full_name, u.email) as name, ra.can_read, ra.can_use, ra.can_modify, ra.can_delete, ra.can_void
          from kernel.record_access ra left join kernel.roles r on r.id = ra.grantee_role_id left join kernel.v_users u on u.id = ra.grantee_user_id
          where ra.company_id = ${caller.claims.active_company_id} and ra.entity = ${entity.id} and ra.record_id = ${record.id}
          order by ra.seq`,
        tx<{ id: string; name: string }[]>`select id, name from kernel.roles where company_id = ${caller.claims.active_company_id} order by name`,
        tx<{ id: string; name: string }[]>`select id, coalesce(full_name, email, id::text) as name from kernel.v_users order by 2`,
      ]);
      accessView = {
        grants: grants.map((g) => ({
          kind: g.role_id ? ("role" as const) : ("user" as const),
          id: (g.role_id ?? g.user_id)!,
          name: g.name ?? "",
          rights: (["read", "use", "modify", "delete", "void"] as const).filter((r) => g[`can_${r}`]),
        })),
        options: [...roles.map((r) => ({ kind: "role" as const, id: r.id, name: r.name })), ...users.map((u) => ({ kind: "user" as const, id: u.id, name: u.name }))],
      };
    }
    // Task 43 (R43-7): a shipped entrega's pedido, to know whether the void may offer to reserve the stock again (sales' own masked view).
    const [order] =
      entity.id === "sales.delivery" && record && typeof record.order_id === "string"
        ? await tx<{ stage: string | null; status: string | null }[]>`select stage, status from sales.v_orders where id = ${record.order_id}::uuid`
        : [];
    // A pedido of another salesperson, or a line of one, that a snapshot names (an entrega, devolución or factura) reads as «Pedido no
    // disponible» (Task 39, R39-9, final review m1).
    const hiddenOrders = await unreadableOrderIds(tx, snapshots);
    return { menu, status, flags, access, authors, recipients, snapshots, hiddenOrders, headerNames, lineNames, accessView, order };
  });

  const show = (value: unknown, field: FieldDef | undefined): string => {
    if (value === null || value === undefined || value === "") return "";
    if (field?.valuesKey && typeof value === "string") {
      const key = `${field.valuesKey}.${value}`;
      const label = t(key);
      return label && label !== key ? label : value;
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  };
  const unavailable = t("sales.view.order_unavailable");
  const shown = (row: Record<string, unknown> | undefined, names: string[], fields: FieldDef[]) =>
    Object.fromEntries(
      names.map((n) => {
        const raw = row?.[n];
        if (raw === MASKED) return [n, MASKED];
        if ((n === "order_id" || n === "order_line_id") && typeof raw === "string" && facts.hiddenOrders.has(raw)) return [n, unavailable];
        return [n, show(raw, fields.find((f) => f.name === n))];
      }),
    );
  const snapshots =
    facts.snapshots?.map(
      (s): SnapshotView => ({
        version: Number(s.version),
        status: s.status,
        at: s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
        by: s.by_name,
        reason: s.reason,
        header: shown(s.header, facts.headerNames, entity.fields),
        lines: (s.lines ?? []).map((l) => shown(l, facts.lineNames, linesEntity?.fields ?? [])),
      }),
    ) ?? null;
  const label = (f: FieldDef) => {
    const text = t(f.label);
    return text && text !== f.label ? text : f.name;
  };

  const menuOk = facts.menu ? facts.menu.allowed : true;
  const may = (verb: string) => menuOk && runnable.has(`${entity.id}.${verb}`);
  return {
    entityType,
    status: facts.status,
    flags: facts.flags,
    rights: {
      // Guardar saves the Datos form (the create or update process the caller may run); a documento's also runs its Grabar.
      modify: menuOk && canSave && (entityType === "maestro" || may("save")) && facts.access.modify,
      submit: may("submit") && facts.access.modify,
      delete: may("delete") && facts.access.delete,
      void: may("void") && facts.access.void,
      // Aprobar and No aprobar each follow their own process (review m6); the creator or last editor may approve (owner rule).
      approve: may("approve") && facts.access.modify,
      reject: may("reject") && facts.access.modify,
    },
    tools: {
      new: runnable.has(entity.processIds?.create ?? `${entity.id}.create`),
      print: record !== null && runnable.has("kernel.doc_template.print"),
      notify: record !== null && entityType === "documento" && runnable.has("kernel.record.notify"),
    },
    listHref: facts.menu?.href ?? "/",
    updatedAt: iso(record?.updated_at),
    createdAt: iso(record?.created_at),
    updatedAtText: iso(record?.updated_at),
    createdBy: facts.authors?.created_by_name ?? null,
    updatedBy: facts.authors?.updated_by_name ?? null,
    recipients: facts.recipients,
    snapshots,
    versionLabels: {
      header: Object.fromEntries(entity.fields.filter((f) => facts.headerNames.includes(f.name)).map((f) => [f.name, label(f)])),
      lines: Object.fromEntries((linesEntity?.fields ?? []).filter((f) => facts.lineNames.includes(f.name)).map((f) => [f.name, label(f)])),
    },
    access: facts.accessView,
    ...(entity.id === "sales.delivery" && record?.stage === "shipped" && facts.status !== "voided" && facts.order && facts.order.stage !== "cancelled" && facts.order.status !== "voided"
      ? { voidOption: { label: t("sales.view.void_reserve_question"), defaultChecked: true } }
      : {}),
  };
}
