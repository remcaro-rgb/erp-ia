---
title: "Comprobantes contables y Fuentes"
routes:
  - /accounting/entries
  - /accounting/journals
processes:
  - accounting.entry.create
  - accounting.entry.update
  - accounting.entry.submit
  - accounting.entry.post
  - accounting.entry.reverse
  - accounting.entry.void
  - accounting.entry.from_template
  - accounting.entry.consult
  - accounting.journal.create
  - accounting.journal.update
  - accounting.journal.consult
---

# Comprobantes contables y Fuentes

Un **comprobante** es un asiento contable: una fecha, una fuente y líneas que suman lo mismo al débito que al crédito. Entra por **Contabilidad › Comprobantes**.

[Captura: listado de Comprobantes]

## El listado

Trae Número, Fecha, Fuente, Descripción, Débito, Crédito, Estado y Origen. Los filtros rápidos son **Hoy**, **Este período**, **Borradores**, **Por aprobar**, **Automáticos** y **Manuales**.

El **Estado** puede ser **Borrador**, **Por aprobar**, **Contabilizado**, **Revertido** o **Anulado**. El **Origen** es **Manual** (lo hizo una persona), **Automático** (lo contabilizó el sistema a partir de una factura, un recibo u otro documento), **Plantilla** o **Importado**.

Los comprobantes automáticos no se escriben: nacen de las reglas contables (guía **Reglas contables**).

## Crear un comprobante manual

1. Pulsa **Nuevo**. Se abre un **Comprobante nuevo** en estado **Borrador**.
2. En **Encabezado** elige la **Fuente** (por defecto, la de comprobantes manuales), la **Fecha** y escribe la **Descripción**. Si la empresa usa unidades de negocio, la **Unidad de negocio** del encabezado la heredan las líneas que no tengan una propia.
3. En **Líneas** agrega cada línea con **Agregar línea**: **Cuenta** (escribe el código o el nombre; la lupa busca), **Tercero** (si la cuenta lo exige), **Centro de costo**, **Auxiliar abierto**, **Ítem**, **Unidad de negocio**, **Descripción**, **Débito** o **Crédito**. Solo se ofrecen las cuentas en las que puedes contabilizar.
4. Con el teclado: **Tab** avanza entre columnas y **Enter** en la última celda agrega una línea. Para quitar una línea, usa **Quitar la línea n**.
5. El pie muestra **Débito**, **Crédito** y **Diferencia**. Mientras no cuadre dice «Descuadrado: falta $ …»; cuando cuadra dice **Cuadrado**.
6. Si la empresa exige soporte, adjúntalo en la pestaña **Archivos** («Adjunta el soporte en la pestaña Archivos antes de contabilizar»).
7. Pulsa **Contabilizar**. El comprobante recibe su número consecutivo («Contabilizado como NC-…») y queda de solo lectura.

Para causar un gasto que se anula solo al mes siguiente, llena **Reversar el** con la fecha en que debe crearse el comprobante espejo (guía **Controles y cierre**).

[Captura: comprobante en borrador con la tabla de líneas]

## Nuevo desde plantilla

Pulsa **Nuevo desde plantilla**, elige la **Plantilla**, la **Fecha** y los **Valores por línea**, y pulsa **Crear borrador**. Revísalo y pulsa **Contabilizar**.

## Aprobación por otra persona

Si el administrador activó **Aprobación de comprobantes manuales** en Reglas contables › Configuración:

1. Quien lo hizo pulsa **Enviar a aprobación**: pasa a **Por aprobar** y queda de solo lectura.
2. Otra persona con permiso lo abre y pulsa **Aprobar y contabilizar**. Quien creó el comprobante no puede aprobarlo («Otra persona debe aprobar»).
3. Si hay algo por corregir, **Devolver a borrador** lo regresa al autor.

El filtro **Por aprobar** y el indicador de Inicio cuentan los pendientes.

## Reversar y anular

- **Reversar** (en un comprobante contabilizado): elige la fecha y escribe el **Motivo**; se crea un comprobante nuevo con las líneas invertidas. Los dos se enlazan con «Reversión de» y «Revertido por». Nunca se borra nada.
- **Anular borrador**: descarta un borrador que no se contabilizó.

## La pestaña Origen

En **Origen** ves el tipo, el documento de origen (con enlace a la factura, por ejemplo), el evento, la regla contable que lo generó, quién lo creó, envió y contabilizó, y la **Cadena causal** con el historial de auditoría.

## Líneas de cuentas restringidas

Si un comprobante tiene líneas de cuentas que tu rol no ve, esas líneas se muestran como **Línea de una cuenta restringida**, con los valores ocultos, y no se pueden editar; los totales del comprobante siguen completos.

## Fuentes

Una **Fuente** es el tipo de comprobante (NC Notas de contabilidad, VT Ventas, CP Compras, RC Recibos de caja, CE Comprobantes de egreso, AP Apertura y CI Cierre). Se administran en **Maestros › Fuentes**: cada una tiene su **Consecutivo** y la casilla **Admite comprobantes manuales** (Apertura y Cierre no la tienen, porque los hace el sistema). Para crear una, pulsa **Nuevo** e indica Código, Descripción y Clase.

## Si algo no funciona

- «Descuadrado»: ajusta las líneas hasta que la **Diferencia** sea cero.
- El período está cerrado: pide a quien administra los períodos que lo reabra (guía **Períodos y cierre**).
- La cuenta exige un dato (tercero, centro de costo…) y la línea no lo trae: el sistema lo pide antes de contabilizar.
