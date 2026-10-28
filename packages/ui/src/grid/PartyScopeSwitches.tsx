"use client";

import { useTranslations } from "next-intl";
import type { GridStateInput } from "./types";

type Filter = NonNullable<GridStateInput["filters"]>[number];

/** A role's party scope (design §5.18, `kernel.roles.party_scope`). */
export type PartyScope = "ambos" | "clientes" | "proveedores" | "ninguno";

export interface PartySwitches {
  customers: boolean;
  suppliers: boolean;
}

/**
 * The fixed filter of the Terceros grid for the switches (prototype `gridRows`): both on shows everything the role's
 * scope lets through (the view already applies it); one on shows the parties of that kind, dual ones included; both
 * off shows nothing. A switch the scope does not offer counts as off.
 */
export function partyKindFilters(scope: PartyScope, switches: PartySwitches): Filter[] {
  const customers = switches.customers && scope !== "proveedores" && scope !== "ninguno";
  const suppliers = switches.suppliers && scope !== "clientes" && scope !== "ninguno";
  const offered = { customers: scope === "ambos" || scope === "clientes", suppliers: scope === "ambos" || scope === "proveedores" };
  if ((customers || !offered.customers) && (suppliers || !offered.suppliers)) return [];
  if (customers && !suppliers) return [{ field: "kind", op: "eq", value: "customer" }];
  if (suppliers && !customers) return [{ field: "kind", op: "eq", value: "supplier" }];
  // Nothing chosen: no row has a null id.
  return [{ field: "id", op: "is_null" }];
}

export interface PartyScopeSwitchesProps {
  scope: PartyScope;
  value: PartySwitches;
  onChange: (value: PartySwitches) => void;
}

/** "Mostrar clientes" / "Mostrar proveedores" (prototype `sw`), only the ones the role's scope covers, and the scope's pill. */
export function PartyScopeSwitches({ scope, value, onChange }: PartyScopeSwitchesProps) {
  const t = useTranslations();
  const toggle = (key: keyof PartySwitches, label: string) => (
    <label className="erp-switch">
      <button type="button" role="switch" aria-checked={value[key]} aria-label={label} className={value[key] ? "erp-toggle is-on" : "erp-toggle"} onClick={() => onChange({ ...value, [key]: !value[key] })} />
      {label}
    </label>
  );
  return (
    <span className="erp-row">
      {scope !== "proveedores" && scope !== "ninguno" && toggle("customers", t("grid.scope.customers"))}
      {scope !== "clientes" && scope !== "ninguno" && toggle("suppliers", t("grid.scope.suppliers"))}
      {scope !== "ambos" && (
        <span className="erp-pill erp-pill--gray" title={t("grid.scope.hint")}>
          {t("grid.scope.only", { scope: t(`grid.scope.${scope}`) })}
        </span>
      )}
    </span>
  );
}
