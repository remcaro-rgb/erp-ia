"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Block, TemplateScope } from "@erp/kernel";
import type { PlantillasData, TemplateEntity, TemplateField } from "@/lib/parametros/load";

/** The page a template is laid on (A4, in points): a record prints portrait, a list landscape (the built-in templates' sizes). */
export const PAGE: Record<TemplateScope, { w: number; h: number }> = { record: { w: 595, h: 842 }, list: { w: 842, h: 595 } };

/** The text a variable block shows in the preview: the company's own data, the print's facts as examples. */
function variableText(value: string, company: PlantillasData["company"], t: ReturnType<typeof useTranslations>): string {
  switch (value) {
    case "empresa.nombre":
      return company.name;
    case "empresa.nit":
      return company.taxId;
    case "empresa.direccion":
      return company.address;
    case "empresa.ciudad":
      return company.city;
    case "empresa.telefono":
      return company.phone;
    case "usuario.nombre":
      return t("common.parametros.plantillas.sample_user");
    case "fecha_impresion":
      return "2026/11/02 10:15";
    case "registros":
      return "3";
    default:
      return value.startsWith("total.") ? "$ 1.234.567,00" : value;
  }
}

const labelOf = (fields: readonly TemplateField[] | null, name: string, t: ReturnType<typeof useTranslations>) => {
  const field = fields?.find((f) => f.name === name);
  return field && t.has(field.label) ? t(field.label) : name;
};

/**
 * The live preview of the template being edited (spec §6: a form-based block list with live preview; prototype «Vista previa»): each block
 * where it prints, fields as their label in angle quotes, the lines or rows as a table head with sample rows. A click selects a block.
 */
export function TemplatePreview({ blocks, scope, entity, company, background, selected, onSelect }: {
  blocks: readonly Block[];
  scope: TemplateScope;
  entity: TemplateEntity;
  company: PlantillasData["company"];
  background: boolean;
  selected: number;
  onSelect: (i: number) => void;
}) {
  const t = useTranslations();
  const page = PAGE[scope];
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / page.w));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [page.w]);
  const tableColumns = scope === "list" ? entity.fields : (entity.lineColumns ?? []);

  const content = (b: Block) => {
    switch (b.kind) {
      case "text":
        return b.value ?? "";
      case "variable":
        return variableText(b.value ?? "", company, t);
      case "field":
        return `‹${labelOf(entity.fields, b.value ?? "", t)}›`;
      case "image":
        return <span className="erp-tpl__logo">{company.logoAttachmentId ? t("common.parametros.plantillas.logo") : t("common.parametros.plantillas.no_logo")}</span>;
      case "page_number":
        return (b.value ?? (t.raw("common.print.page_number") as string)).replace("{n}", "1").replace("{total}", "1");
      case "lines": {
        const columns = b.columns && b.columns.length > 0 ? b.columns : tableColumns.map((c) => c.name);
        return (
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{labelOf(tableColumns, c, t)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[1, 2].map((r) => (
                <tr key={r}>
                  {columns.map((c) => (
                    <td key={c}>{tableColumns.find((f) => f.name === c)?.money ? "$ 1.000,00" : "…"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
    }
  };

  return (
    <div ref={host} className="erp-tpl__preview" data-testid="template-preview" style={{ height: page.h * scale }}>
      <div className={`erp-tpl__page${background ? " has-bg" : ""}`} style={{ width: page.w, height: page.h, transform: `scale(${scale})` }}>
        {blocks.map((b, i) => (
          <div
            key={i}
            className={`erp-tpl__blk${i === selected ? " is-on" : ""}`}
            style={{
              left: b.x,
              top: b.y,
              width: b.w,
              ...(b.h ? { height: b.h } : {}),
              fontSize: b.font?.size ?? 9,
              fontWeight: b.font?.bold ? 700 : 400,
              textAlign: b.align ?? "left",
            }}
            onClick={() => onSelect(i)}
          >
            {content(b)}
          </div>
        ))}
      </div>
    </div>
  );
}
