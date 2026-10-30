---
title: "Períodos y cierre"
routes:
  - /accounting/periods
processes:
  - accounting.period.consult
  - accounting.period.close
  - accounting.period.reopen
  - accounting.year.close
  - accounting.year.reopen
  - accounting.fiscal_year.open
  - accounting.fiscal_year.consult
---

# Períodos y cierre

Cada mes del año fiscal es un **período**. Mientras está **Abierto** se contabiliza en él; al cerrarlo, ya no. Cerrar el mes protege las cifras que ya reportaste. Entra por **Contabilidad › Períodos**.

[Captura: Períodos del año con el botón Cerrar]

## Qué ves

Una tarjeta por **Año fiscal** («3 de 12 períodos cerrados»). Al abrirla, la tabla **Períodos del año** trae, por mes: Período, Estado, Comprobantes, Débito, Crédito y **Por contabilizar** (borradores y comprobantes por aprobar), con los botones **Cerrar** y **Reabrir**.

## Cómo cierro el mes

1. Entra a **Contabilidad › Períodos** y busca el mes abierto.
2. Antes de cerrar, revisa que no queden comprobantes **Por contabilizar**: contabilízalos, apruébalos o anúlalos (guía **Comprobantes**) y atiende **Pendientes de contabilizar** (guía **Pendientes de contabilizar**).
3. Pulsa **Cerrar**. Se abre «Cerrar [mes]» y pide tu código de verificación de 6 dígitos.
4. Pulsa **Cerrar período**. El sistema corre las **Verificaciones de cierre**; si todas pasan, el período queda **Cerrado**.
5. Si alguna falla, el período sigue abierto («Falló 1 verificación: el período sigue abierto») y la lista dice cuál fue y con qué cifras. Corrige la causa y pulsa **Volver a intentar**.

## Las verificaciones de cierre

Cada intento queda registrado con quién lo corrió, cuándo y qué cifras comparó (pestaña **Cierre** del período):

- **Sin borradores**.
- **Sin comprobantes por aprobar**.
- **Sin pendientes de contabilizar**.
- **Sin eventos por despachar**: ningún documento de otro módulo espera contabilizarse.
- **Control de cartera**, **Control de proveedores** y **Control de inventario**: el saldo de la cuenta de control cuadra con sus auxiliares (informe **Conciliación de control**, guía **Controles y cierre**).
- **Cuenta transitoria en cero**.
- **Ajuste al peso dentro de la tolerancia**.
- **Sin saldos contrarios a la naturaleza**.

## Reabrir un período

Si olvidaste algo, pulsa **Reabrir** en el período cerrado. Pide tu código de verificación y te deja elegir **Qué reabrir**:

- **Todo el período**, o
- **Solo un día**: indica el **Día**. Mientras esté reabierto solo se contabilizan comprobantes con esa fecha.

El período muestra cuántas veces se ha reabierto («reabierto 2 veces»), y todo queda en la auditoría. Al terminar, ciérralo otra vez.

## Cerrar el año

Con los 12 períodos cerrados:

1. En la tarjeta del año pulsa **Cerrar año**.
2. Revisa la **Vista previa del cierre**: **Ingresos del año**, **Gastos del año** y **Utilidad del ejercicio** (o **Pérdida del ejercicio**).
3. Escribe tu código de verificación y confirma. Se saldan las cuentas de resultado contra ganancias y pérdidas, se crea el comprobante de cierre y se abre el año siguiente.

Si faltan cuentas por mapear («Faltan por mapear las cuentas de ganancias y pérdidas…») ve a **Reglas contables › Mapeo de cuentas** (guía **Reglas contables**).

**Reabrir año** revierte los comprobantes de cierre y vuelve a abrir el año y su último período; también pide el código.

## Si algo no funciona

- «Cerrar» está desactivado: tu rol no tiene permiso de cierre; pídeselo al administrador.
- Un documento que llega a un período cerrado no se pierde: queda en **Pendientes de contabilizar** con el motivo **Período cerrado**; reabre el período y pulsa **Reintentar**.
