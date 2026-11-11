"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { Block, BlockKind, TemplateScope } from "@erp/kernel";
import { adminAction } from "@/lib/admin/actions";
import type { PlantillasData, TemplateEntity, TemplateRow } from "@/lib/parametros/load";
import { previewTemplateAction } from "@/lib/records/lifecycle-actions";
import { downloadPrint } from "@/lib/records/print-client";
import { StepUpDock, useAdminAction } from "../../../admin/_components/use-admin-action";
import { PAGE, TemplatePreview } from "./template-preview";

// Plantillas PDF (spec §6, approved prototype «Editor de plantillas»): the module's templates of each maestro and documento, record or
// list. The editor is a block list with a live preview (no visual designer): fixed text, system variables, record fields, the lines or
// rows table, the company logo and the page number, over an optional background PDF. Guardar runs kernel.doc_template.save with the
// version the editor read (expectedVersion: a template another admin saved meanwhile is refused, never overwritten); the default
// switch runs kernel.doc_template.set_default. Both are company-admin processes with step-up. The letterhead's logo is a PNG or JPEG
// attached to a template and named by the company (kernel.admin.company.update).

const KINDS: readonly BlockKind[] = ["text", "variable", "field", "lines", "image", "page_number"];
const IMAGE_VARIABLES = ["empresa.logo"];

interface Draft {
  id: string | null;
  entity: string;
  scope: TemplateScope;
  name: string;
  version: number;
  backgroundFileId: string | null;
  blocks: Block[];
}

const draftOf = (row: TemplateRow): Draft => ({ id: row.id, entity: row.entity, scope: row.scope, name: row.name, version: row.version, backgroundFileId: row.backgroundFileId, blocks: row.blocks.map((b) => ({ ...b })) });
const blankOf = (entity: TemplateEntity, scope: TemplateScope): Draft => ({ id: null, entity: entity.id, scope, name: "", version: 0, backgroundFileId: null, blocks: entity.defaults[scope].map((b) => ({ ...b })) });
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** Uploads `file` as an attachment of the template (POST /api/attachments, kernel.attachment.add): its id, or the refusal's text. */
async function attach(templateId: string, tag: string, file: File): Promise<{ id: string } | { error: string }> {
  const body = new FormData();
  body.set("entity", "kernel.doc_template");
  body.set("recordId", templateId);
  body.set("tag", tag);
  body.set("file", file);
  const response = await fetch("/api/attachments", { method: "POST", body });
  const answer = (await response.json().catch(() => null)) as { id?: string; details?: unknown } | null;
  if (response.ok && answer?.id) return { id: answer.id };
  const details = Array.isArray(answer?.details) ? answer.details.filter((d): d is string => typeof d === "string") : [];
  return { error: details.join(" · ") };
}

export function PlantillasScreen({ data }: { data: PlantillasData }) {
  const t = useTranslations();
  const base = useId();
  const router = useRouter();
  const { perform, execute, prompt, status, busy, reset } = useAdminAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stored, setStored] = useState<Draft | null>(null);
  const [selected, setSelected] = useState(-1);
  const [addKind, setAddKind] = useState<BlockKind>("text");
  const [stale, setStale] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    // The server's data again (after a save): an open saved template follows it unless the editor holds unsaved changes.
    if (draft?.id && stored && same(draft, stored)) {
      const row = data.templates.find((r) => r.id === draft.id);
      if (row) {
        setDraft(draftOf(row));
        setStored(draftOf(row));
      }
    }
  }

  const entityOf = (id: string) => data.entities.find((e) => e.id === id)!;
  const row = draft?.id ? data.templates.find((r) => r.id === draft.id) : undefined;
  const dirty = draft !== null && (stored === null || !same(draft, stored));
  const entityLabel = (e: TemplateEntity) => t("common.parametros.entity_option", { entity: t(e.label), kind: t(`common.parametros.kind_lower.${e.type}`) });

  const open = (r: TemplateRow) => {
    reset();
    setStale(false);
    setNote(null);
    setDraft(draftOf(r));
    setStored(draftOf(r));
    setSelected(-1);
  };
  const create = () => {
    reset();
    setStale(false);
    setNote(null);
    setDraft(blankOf(data.entities[0]!, "record"));
    setStored(null);
    setSelected(-1);
  };
  const change = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setBlock = (i: number, patch: Partial<Block>) => setDraft((d) => (d ? { ...d, blocks: d.blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as Block) : b)) } : d));
  const removeBlock = (i: number) => {
    setDraft((d) => (d ? { ...d, blocks: d.blocks.filter((_, j) => j !== i) } : d));
    setSelected(-1);
  };
  const moveBlock = (i: number, by: number) => {
    setDraft((d) => {
      if (!d) return d;
      const j = i + by;
      if (j < 0 || j >= d.blocks.length) return d;
      const blocks = [...d.blocks];
      [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
      return { ...d, blocks };
    });
    setSelected(i + by);
  };
  const addBlock = (kind: BlockKind, value?: string) => {
    if (!draft) return;
    const entity = entityOf(draft.entity);
    const page = PAGE[draft.scope];
    const block: Block =
      kind === "lines"
        ? { kind, x: 40, y: Math.round(page.h / 2), w: page.w - 80, font: { size: 8 } }
        : kind === "image"
          ? { kind, x: 40, y: 40, w: 70, h: 44, value: "empresa.logo" }
          : {
              kind,
              x: 40,
              y: page.h - 120,
              w: 220,
              font: { size: 10 },
              value:
                value ??
                (kind === "text"
                  ? t("common.parametros.plantillas.new_text")
                  : kind === "variable"
                    ? "empresa.nombre"
                    : kind === "field"
                      ? (entity.fields[0]?.name ?? "")
                      : (t.raw("common.print.page_number") as string)),
            };
    setDraft({ ...draft, blocks: [...draft.blocks, block] });
    setSelected(draft.blocks.length);
  };

  const save = async () => {
    if (!draft) return;
    setStale(false);
    const input = {
      ...(draft.id ? { id: draft.id, expectedVersion: draft.version } : {}),
      entity: draft.entity,
      scope: draft.scope,
      name: draft.name,
      blocks: draft.blocks,
      backgroundFileId: draft.backgroundFileId,
    };
    const result = await execute<{ output: unknown }>((token) => adminAction("kernel.doc_template.save", input, token));
    if (result.ok) {
      const out = result.output as { id: string; version: number };
      const next = { ...draft, id: out.id, version: out.version };
      setDraft(next);
      setStored(next);
    } else if (result.code === "stale_record") setStale(true);
  };
  const reload = () => {
    setStale(false);
    reset();
    if (row) {
      setDraft(draftOf(row));
      setStored(draftOf(row));
    }
    router.refresh();
  };
  const toggleDefault = async () => {
    if (!draft?.id || !row) return;
    await perform("kernel.doc_template.set_default", { entity: draft.entity, scope: draft.scope, id: row.isDefault ? null : draft.id });
  };
  const viewPdf = async () => {
    if (!draft?.id) return;
    setNote(null);
    const printed = await previewTemplateAction(draft.entity, draft.scope, draft.id);
    if (!printed.ok) return setNote(printed.messages.join(" · ") || (t.has(`errors.${printed.code}`) ? t(`errors.${printed.code}`) : t("errors.unknown")));
    if (!(await downloadPrint(printed.fileId))) setNote(t("grid.print_failed"));
  };
  const upload = async (file: File | undefined, tag: "Fondo" | "Logo") => {
    if (!file || !draft?.id) return;
    setNote(null);
    const attached = await attach(draft.id, tag, file);
    if ("error" in attached) return setNote(attached.error || t("common.parametros.plantillas.upload_failed"));
    if (tag === "Fondo") change({ backgroundFileId: attached.id });
    else await perform("kernel.admin.company.update", { logoAttachmentId: attached.id });
    router.refresh();
  };

  const entity = draft ? entityOf(draft.entity) : null;
  const block = draft && selected >= 0 ? draft.blocks[selected] : undefined;
  const tableColumns = entity && draft ? (draft.scope === "list" ? entity.fields : (entity.lineColumns ?? [])) : [];
  const files = row?.files ?? [];
  const summary = (b: Block) => (b.kind === "lines" ? (b.columns ?? []).join(", ") || t("common.parametros.plantillas.all_columns") : (b.value ?? ""));

  return (
    <div className="erp-stack erp-param">
      <div className="erp-row">
        <h1>{t("nav.section.page.doc_templates")}</h1>
        <span className="erp-pill erp-pill--info">{t("nav.section.parametros")}</span>
        <span className="erp-grow" />
        <button type="button" className="erp-btn" onClick={create} disabled={busy}>
          {t("common.parametros.plantillas.new")}
        </button>
      </div>
      <p className="erp-muted">{t("common.parametros.plantillas.intro")}</p>
      <section className="erp-card">
        <div className="erp-param__scroll">
          <table className="erp-param__table">
            <thead>
              <tr>
                <th>{t("common.parametros.plantillas.name")}</th>
                <th>{t("common.parametros.entity")}</th>
                <th>{t("common.parametros.plantillas.scope")}</th>
                <th className="is-num">{t("common.parametros.plantillas.version")}</th>
                <th>{t("common.parametros.plantillas.default")}</th>
              </tr>
            </thead>
            <tbody>
              {data.templates.length === 0 && (
                <tr>
                  <td colSpan={5} className="erp-muted">
                    {t("common.parametros.plantillas.empty")}
                  </td>
                </tr>
              )}
              {data.templates.map((r) => (
                <tr key={r.id} aria-selected={draft?.id === r.id}>
                  <td>
                    <button type="button" className="erp-link" onClick={() => open(r)}>
                      {r.name}
                    </button>
                  </td>
                  <td>{t(entityOf(r.entity).label)}</td>
                  <td>{t(`common.parametros.plantillas.scope_${r.scope}`)}</td>
                  <td className="is-num">v{r.version}</td>
                  <td>{r.isDefault ? <span className="erp-pill erp-pill--ok">{t("common.parametros.yes")}</span> : <span className="erp-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {draft && entity && (
        <>
          <section className="erp-card erp-stack" style={{ padding: 14 }}>
            <div className="erp-form4">
              <div className="erp-field">
                <label htmlFor={`${base}-name`}>{t("common.parametros.plantillas.name")}</label>
                <input id={`${base}-name`} value={draft.name} maxLength={120} onChange={(e) => change({ name: e.target.value })} />
              </div>
              <div className="erp-field">
                <label htmlFor={`${base}-entity`}>{t("common.parametros.entity")}</label>
                <select
                  id={`${base}-entity`}
                  value={draft.entity}
                  disabled={draft.id !== null}
                  onChange={(e) => {
                    setDraft({ ...blankOf(entityOf(e.target.value), draft.scope), name: draft.name });
                    setSelected(-1);
                  }}
                >
                  {data.entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {entityLabel(e)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="erp-field">
                <label htmlFor={`${base}-scope`}>{t("common.parametros.plantillas.scope")}</label>
                <select
                  id={`${base}-scope`}
                  value={draft.scope}
                  disabled={draft.id !== null}
                  onChange={(e) => {
                    setDraft({ ...blankOf(entity, e.target.value as TemplateScope), name: draft.name });
                    setSelected(-1);
                  }}
                >
                  <option value="record">{t("common.parametros.plantillas.scope_record")}</option>
                  <option value="list">{t("common.parametros.plantillas.scope_list")}</option>
                </select>
              </div>
              <div className="erp-field">
                <span className="erp-field__label">{t("common.parametros.plantillas.version")}</span>
                <div className="erp-row" style={{ minHeight: 34 }}>
                  <span className="erp-pill erp-pill--gray erp-mono">{draft.id ? `v${draft.version}` : "—"}</span>
                  <span className="erp-small erp-muted">{dirty && draft.id ? t("common.parametros.plantillas.next_version", { version: draft.version + 1 }) : t("common.parametros.plantillas.versions_hint")}</span>
                </div>
              </div>
            </div>
            <div className="erp-row erp-row--wrap">
              {row && (
                <span className="erp-row">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={row.isDefault}
                    aria-label={t("common.parametros.plantillas.default_for", { entity: t(entity.label), scope: t(`common.parametros.plantillas.scope_${draft.scope}`) })}
                    className={`erp-toggle${row.isDefault ? " is-on" : ""}`}
                    disabled={busy}
                    onClick={() => void toggleDefault()}
                  />
                  <span className="erp-small">{t("common.parametros.plantillas.default_for", { entity: t(entity.label), scope: t(`common.parametros.plantillas.scope_${draft.scope}`) })}</span>
                </span>
              )}
              <span className="erp-grow" />
              <button type="button" className="erp-btn" disabled={busy || !draft.id || dirty} title={dirty ? t("common.parametros.plantillas.save_first") : undefined} onClick={() => void viewPdf()}>
                {t("common.parametros.plantillas.view_pdf")}
              </button>
              <button type="button" className="erp-btn erp-btn--primary" disabled={busy || !dirty || draft.name.trim() === ""} onClick={() => void save()}>
                {t("common.parametros.save")}
              </button>
            </div>
            {stale && (
              <div role="alert" className="erp-dian erp-dian--bad erp-row">
                <span className="erp-grow">{t("common.parametros.plantillas.stale")}</span>
                <button type="button" className="erp-btn erp-btn--sm" onClick={reload}>
                  {t("common.parametros.plantillas.reload")}
                </button>
              </div>
            )}
            {status}
            {note && (
              <div role="alert" className="erp-dian erp-dian--bad">
                {note}
              </div>
            )}
          </section>

          <div className="erp-tpl">
            <div className="erp-stack" style={{ minWidth: 0 }}>
              <section className="erp-card erp-stack" style={{ padding: 12 }}>
                <h3>{t("common.parametros.plantillas.background")}</h3>
                {!draft.id ? (
                  <span className="erp-small erp-muted">{t("common.parametros.plantillas.save_to_attach")}</span>
                ) : (
                  <>
                    <div className="erp-field">
                      <label htmlFor={`${base}-bg`}>{t("common.parametros.plantillas.background_file")}</label>
                      <select id={`${base}-bg`} value={draft.backgroundFileId ?? ""} onChange={(e) => change({ backgroundFileId: e.target.value || null })}>
                        <option value="">{t("common.parametros.plantillas.no_background")}</option>
                        {files
                          .filter((f) => f.mimeType === "application/pdf")
                          .map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.fileName}
                            </option>
                          ))}
                      </select>
                    </div>
                    <label className="erp-btn erp-btn--sm" style={{ alignSelf: "flex-start" }}>
                      {t("common.parametros.plantillas.upload_background")}
                      <input type="file" accept="application/pdf" hidden onChange={(e) => void upload(e.target.files?.[0], "Fondo")} />
                    </label>
                    <span className="erp-small erp-muted">{t("common.parametros.plantillas.background_hint")}</span>
                  </>
                )}
              </section>

              <section className="erp-card erp-stack" style={{ padding: 12 }}>
                <h3>{t("common.parametros.plantillas.logo_title")}</h3>
                <span className="erp-small erp-muted">{data.company.logoAttachmentId ? t("common.parametros.plantillas.logo_set") : t("common.parametros.plantillas.logo_none")}</span>
                {draft.id ? (
                  <div className="erp-row erp-row--wrap">
                    <label className="erp-btn erp-btn--sm">
                      {t("common.parametros.plantillas.upload_logo")}
                      <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => void upload(e.target.files?.[0], "Logo")} />
                    </label>
                    {data.company.logoAttachmentId && (
                      <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost" disabled={busy} onClick={() => void perform("kernel.admin.company.update", { logoAttachmentId: null })}>
                        {t("common.parametros.plantillas.remove_logo")}
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="erp-small erp-muted">{t("common.parametros.plantillas.save_to_attach")}</span>
                )}
                <span className="erp-small erp-muted">{t("common.parametros.plantillas.company_hint")}</span>
              </section>

              <section className="erp-card erp-stack" style={{ padding: 12 }}>
                <div className="erp-row erp-row--wrap">
                  <h3>{t("common.parametros.plantillas.blocks")}</h3>
                  <span className="erp-small erp-muted">{draft.blocks.length} / 200</span>
                  <span className="erp-grow" />
                  <select aria-label={t("common.parametros.plantillas.block_kind")} value={addKind} onChange={(e) => setAddKind(e.target.value as BlockKind)}>
                    {KINDS.filter((k) => k !== "lines" || tableColumns.length > 0)
                      .filter((k) => k !== "field" || draft.scope === "record")
                      .map((k) => (
                        <option key={k} value={k}>
                          {t(`common.parametros.plantillas.kind.${k}`)}
                        </option>
                      ))}
                  </select>
                  <button type="button" className="erp-btn erp-btn--sm" disabled={draft.blocks.length >= 200} onClick={() => addBlock(addKind)}>
                    {t("common.parametros.plantillas.add_block")}
                  </button>
                </div>
                <div className="erp-tpl__blocks">
                  {draft.blocks.map((b, i) => (
                    <div key={i} className={`erp-tpl__item${i === selected ? " is-on" : ""}`}>
                      <div className="erp-row">
                        <button type="button" className="erp-tpl__head erp-grow" aria-expanded={i === selected} onClick={() => setSelected(i === selected ? -1 : i)}>
                          <b>{t(`common.parametros.plantillas.kind.${b.kind}`)}</b> · <span>{summary(b)}</span>
                        </button>
                        <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost" aria-label={t("common.parametros.plantillas.up")} onClick={() => moveBlock(i, -1)}>
                          ▲
                        </button>
                        <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost" aria-label={t("common.parametros.plantillas.down")} onClick={() => moveBlock(i, 1)}>
                          ▼
                        </button>
                        <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost" aria-label={t("common.parametros.plantillas.remove_block")} onClick={() => removeBlock(i)}>
                          ✕
                        </button>
                      </div>
                      {i === selected && block && <BlockEditor block={block} index={i} entity={entity} scope={draft.scope} columns={tableColumns} onChange={(patch) => setBlock(i, patch)} />}
                    </div>
                  ))}
                </div>
              </section>

              <section className="erp-card erp-stack" style={{ padding: 12 }}>
                <h3>{t("common.parametros.plantillas.variables")}</h3>
                <span className="erp-small erp-muted">{t("common.parametros.plantillas.variables_hint")}</span>
                <span className="erp-field__label">{t("common.parametros.plantillas.system")}</span>
                <div className="erp-tpl__vars">
                  {entity.variables[draft.scope].map((v) => (
                    <button key={v} type="button" className="erp-btn erp-btn--sm erp-mono" onClick={() => addBlock("variable", v)}>
                      {v}
                    </button>
                  ))}
                  {IMAGE_VARIABLES.map((v) => (
                    <button key={v} type="button" className="erp-btn erp-btn--sm erp-mono" onClick={() => addBlock("image")}>
                      {v}
                    </button>
                  ))}
                </div>
                {draft.scope === "record" && (
                  <>
                    <span className="erp-field__label">{t("common.parametros.plantillas.record_fields")}</span>
                    <div className="erp-tpl__vars">
                      {entity.fields.map((f) => (
                        <button key={f.name} type="button" className="erp-btn erp-btn--sm" onClick={() => addBlock("field", f.name)}>
                          {t.has(f.label) ? t(f.label) : f.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <span className="erp-small erp-muted">{t("common.parametros.plantillas.masked_hint")}</span>
              </section>
            </div>
            <div className="erp-stack" style={{ minWidth: 0 }}>
              <div className="erp-row">
                <b className="erp-small">{t("common.parametros.plantillas.preview", { w: PAGE[draft.scope].w, h: PAGE[draft.scope].h })}</b>
              </div>
              <TemplatePreview blocks={draft.blocks} scope={draft.scope} entity={entity} company={data.company} background={draft.backgroundFileId !== null} selected={selected} onSelect={setSelected} />
              <span className="erp-small erp-muted">{t("common.parametros.plantillas.preview_hint")}</span>
            </div>
          </div>
        </>
      )}
      <StepUpDock prompt={prompt} />
    </div>
  );
}

function BlockEditor({ block, index, entity, scope, columns, onChange }: {
  block: Block;
  index: number;
  entity: TemplateEntity;
  scope: TemplateScope;
  columns: TemplateEntity["fields"];
  onChange: (patch: Partial<Block>) => void;
}) {
  const t = useTranslations();
  const base = `tpl-${index}`;
  const num = (key: "x" | "y" | "w" | "h", label: string, optional = false) => (
    <div className="erp-field">
      <label htmlFor={`${base}-${key}`}>{label}</label>
      <input
        id={`${base}-${key}`}
        type="number"
        min={key === "w" || key === "h" ? 1 : 0}
        max={1700}
        value={block[key] ?? ""}
        onChange={(e) => {
          const v = e.target.value === "" ? undefined : Number(e.target.value);
          if (v === undefined && !optional) return;
          onChange({ [key]: v } as Partial<Block>);
        }}
      />
    </div>
  );
  const font = block.font ?? { size: 9 };
  return (
    <div className="erp-form4 erp-tpl__editor">
      {block.kind === "text" && (
        <div className="erp-field erp-span2">
          <label htmlFor={`${base}-value`}>{t("common.parametros.plantillas.text")}</label>
          <input id={`${base}-value`} value={block.value ?? ""} maxLength={2000} onChange={(e) => onChange({ value: e.target.value })} />
        </div>
      )}
      {block.kind === "variable" && (
        <div className="erp-field erp-span2">
          <label htmlFor={`${base}-value`}>{t("common.parametros.plantillas.kind.variable")}</label>
          <select id={`${base}-value`} value={block.value ?? ""} onChange={(e) => onChange({ value: e.target.value })}>
            {entity.variables[scope].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      )}
      {block.kind === "field" && (
        <div className="erp-field erp-span2">
          <label htmlFor={`${base}-value`}>{t("common.parametros.plantillas.kind.field")}</label>
          <select id={`${base}-value`} value={block.value ?? ""} onChange={(e) => onChange({ value: e.target.value })}>
            {entity.fields.map((f) => (
              <option key={f.name} value={f.name}>
                {t.has(f.label) ? t(f.label) : f.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {block.kind === "page_number" && (
        <div className="erp-field erp-span2">
          <label htmlFor={`${base}-value`}>{t("common.parametros.plantillas.format")}</label>
          <input id={`${base}-value`} value={block.value ?? ""} placeholder={(t.raw("common.print.page_number") as string)} onChange={(e) => onChange({ value: e.target.value || undefined })} />
        </div>
      )}
      {block.kind === "lines" && (
        <fieldset className="erp-field" style={{ gridColumn: "1 / -1" }}>
          <legend className="erp-field__label">{t("common.parametros.plantillas.columns")}</legend>
          <div className="erp-row erp-row--wrap">
            {columns.map((c) => {
              const on = (block.columns ?? []).includes(c.name);
              return (
                <label key={c.name} className="erp-check">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      const next = columns.map((x) => x.name).filter((n) => (n === c.name ? e.target.checked : (block.columns ?? []).includes(n)));
                      onChange({ columns: next.length > 0 ? next : undefined });
                    }}
                  />
                  {t.has(c.label) ? t(c.label) : c.name}
                </label>
              );
            })}
          </div>
          <span className="erp-small erp-muted">{t("common.parametros.plantillas.all_columns_hint")}</span>
        </fieldset>
      )}
      {num("x", t("common.parametros.plantillas.x"))}
      {num("y", t("common.parametros.plantillas.y"))}
      {num("w", t("common.parametros.plantillas.w"))}
      {num("h", t("common.parametros.plantillas.h"), true)}
      {block.kind !== "image" && (
        <>
          <div className="erp-field">
            <label htmlFor={`${base}-size`}>{t("common.parametros.plantillas.size")}</label>
            <input id={`${base}-size`} type="number" min={4} max={72} value={font.size} onChange={(e) => onChange({ font: { ...font, size: Math.min(72, Math.max(4, Number(e.target.value) || 9)) } })} />
          </div>
          <div className="erp-field">
            <label htmlFor={`${base}-bold`}>{t("common.parametros.plantillas.bold")}</label>
            <select id={`${base}-bold`} value={font.bold ? "1" : "0"} onChange={(e) => onChange({ font: { ...font, bold: e.target.value === "1" } })}>
              <option value="0">{t("common.parametros.no")}</option>
              <option value="1">{t("common.parametros.yes")}</option>
            </select>
          </div>
          <div className="erp-field">
            <label htmlFor={`${base}-align`}>{t("common.parametros.plantillas.align")}</label>
            <select id={`${base}-align`} value={block.align ?? "left"} onChange={(e) => onChange({ align: e.target.value as Block["align"] })}>
              {(["left", "center", "right"] as const).map((a) => (
                <option key={a} value={a}>
                  {t(`common.parametros.plantillas.align_${a}`)}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );
}
