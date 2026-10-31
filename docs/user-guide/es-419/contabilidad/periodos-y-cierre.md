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

1. En la tarjeta del año pulsa **Cerrar año**. Se abre «Cerrar el año 2026».
2. Revisa la **Vista previa del cierre**, que muestra tres cifras: **Ingresos del año**, **Gastos del año** y **Utilidad del ejercicio** (o **Pérdida del ejercicio**). Por ejemplo: $ 10.000.000,00 de ingresos, $ 6.000.000,00 de gastos y $ 4.000.000,00 de utilidad.
3. Pulsa **Cerrar año** y escribe tu código de verificación.

Al confirmar, el sistema crea **dos comprobantes de cierre** en la Fuente **Cierre**, con fecha 31/12 del año: el primero salda las cuentas de ingresos y gastos contra ganancias y pérdidas, y el segundo lleva el resultado a **Utilidad del ejercicio** (o **Pérdida del ejercicio**). El año queda **Cerrado** y se abre el año siguiente con sus 12 períodos.

Si falta cerrar algún período, el diálogo dice «Falta cerrar 1 período del año.» (o «Faltan por cerrar N períodos del año.») y **Cerrar año** queda desactivado: cierra primero esos meses. Si faltan cuentas por mapear («Faltan por mapear las cuentas de ganancias y pérdidas…») ve a **Reglas contables › Mapeo de cuentas** (guía **Reglas contables**).

## Reabrir el año

En la tarjeta de un año cerrado pulsa **Reabrir año**. El diálogo lista los **Comprobantes de cierre por revertir** con su número. Al confirmar con tu código de verificación, esos comprobantes quedan **Revertidos**, el año vuelve a **Abierto** y su último período (diciembre) también. Los años se reabren del más reciente al más antiguo.

## Si algo no funciona

- «Cerrar» está desactivado: tu rol no tiene permiso de cierre; pídeselo al administrador.
- Un documento que llega a un período cerrado no se pierde: queda en **Pendientes de contabilizar** con el motivo **Período cerrado**; reabre el período y pulsa **Reintentar**.
