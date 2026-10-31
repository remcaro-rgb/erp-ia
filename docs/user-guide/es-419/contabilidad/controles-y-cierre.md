---
title: "Controles contables"
routes:
  - /accounting/reports
processes:
  - accounting.report.control_reconciliation
  - accounting.report.manual_entries_audit
  - accounting.entry.submit
  - accounting.entry.post
  - accounting.settings.update
---

# Controles contables

La contabilidad trae cinco controles pequeños, pensados para que un error o un fraude se vea a tiempo. Esta guía explica qué hace cada uno y dónde se maneja. Para cerrar el período paso a paso, mira la guía **Períodos y cierre**.

## 1. Aprobación por otra persona

En **Reglas contables › Configuración › Comprobantes manuales**, activa **Exigir aprobación de otra persona**. Desde entonces un comprobante manual (o el que prepara el asistente) pasa por **Enviar a aprobación** y lo contabiliza otra persona con **Aprobar y contabilizar**. Quien lo creó no puede aprobarlo. **Devolver a borrador** (con un motivo opcional) lo regresa al autor sin cambiar sus líneas; lo puede hacer quien tenga el permiso de contabilizar, aun si el comprobante incluye cuentas restringidas que no ve. Los comprobantes automáticos no pasan por aquí: su control es la regla contable, que solo se cambia con código de verificación.

También puedes exigir **Un archivo adjunto** en cada comprobante manual.

## 2. Reversión automática de causaciones

En el comprobante, el campo **Reversar el** crea, al contabilizarlo, un comprobante espejo en **Borrador** con esa fecha (por ejemplo el 1.º del mes siguiente). Aparece en **Borradores** del siguiente período y bloquea su cierre hasta que lo contabilices, así no se olvida. Al contabilizarlo, el original queda **Revertido**.

## 3. Conciliación de control

En **Informes › Conciliación de control**, elige **A la fecha** y compara, por tercero, el saldo de las cuentas de control (cartera, proveedores, inventario) contra sus auxiliares. La columna **Diferencia** debe ser cero. El cierre del período corre este mismo control y se niega si hay una diferencia mayor a la **Tolerancia de ajuste al peso**.

## 4. Cuenta transitoria en cero

La cuenta transitoria recibe lo que aún no se sabe dónde va. El período no se cierra mientras su saldo al final del mes no sea cero; la conciliación de control muestra las líneas abiertas.

## 5. Auditoría de comprobantes manuales

**Informes › Auditoría de comprobantes manuales** lista, por rango de fechas, todos los comprobantes no automáticos: quién los creó, quién los envió y quién los contabilizó, cuándo, cuántos **Adjuntos** y **Líneas** tienen, el valor, si se **Contabilizó tras el cierre** y si es **Valor redondo** (múltiplo de la cifra que fijes en **Valor redondo desde**; por defecto $ 1.000.000,00). Es la lista que pide un auditor. Haz clic en una fila para abrir el comprobante.

[Captura: Auditoría de comprobantes manuales]

## Quién puede qué

Los permisos se asignan por rol en **Administración**. Cerrar y reabrir períodos, cambiar reglas y la configuración piden además el código de verificación. Todo queda en la auditoría.
