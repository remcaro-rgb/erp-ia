---
title: "Cartera y cuentas por pagar por edades"
routes:
  - /accounting/reports
processes:
  - accounting.report.aging
  - accounting.report.aging_detail
---

# Cartera y cuentas por pagar por edades

Este informe responde «¿quién me debe, desde cuándo?» (cartera) y «¿a quién le debo, desde cuándo?» (cuentas por pagar). Reparte lo pendiente por la edad de cada vencimiento.

## Abrirlo

1. **Contabilidad › Reportes › Informes › Cartera y cuentas por pagar por edades**.
2. En **Tipo** elige **Cartera (clientes)** o **Por pagar (proveedores)**.
3. En **A la fecha** pon el día de corte. Por defecto los rangos son los del sistema; en **Rangos de días** puedes cambiarlos.
4. En **Moneda** elige **Equivalente en COP** (por defecto) o **Moneda del documento**.
5. En **Por vencer** elige **Fuera del total** (por defecto), **Incluir en el total** o **Solo por vencer**.

![Cartera por edades con cinco rangos](img/cartera-por-edades.png)

## Cómo leerlo

Una fila por tercero y las columnas **Por vencer**, **1–30 días**, **31–60 días**, **61–90 días**, **Más de 90 días** y **Anticipos y saldos a favor**, más el **Total**. La edad cuenta los días pasados desde la fecha de vencimiento de cada partida hasta la fecha de corte.

- Una partida abierta es una línea con fecha de vencimiento en una cuenta de cartera (clientes) o de proveedores.
- **Anticipos y saldos a favor** va en negativo y el **Total** ya lo descuenta.
- El **Total** suma solo lo **vencido** (de 1 día en adelante) menos los anticipos: lo **Por vencer** se ve en su columna pero no entra en el total. Con **Por vencer › Incluir en el total**, el total suma también lo por vencer y es el saldo de la cuenta del tercero. Con **Solo por vencer**, el informe muestra solo los terceros con partidas que aún no vencen, y el total es ese valor.
- Haz clic en un tercero para ver sus **partidas abiertas** documento por documento, y en un documento para abrir su comprobante.
- Haz clic en **cualquier valor** (un rango de días, los anticipos o el total de un tercero) para ver los documentos que lo forman: se abre el **Detalle de cartera** en una pestaña nueva, con el nombre del tercero y del rango («Almacenes Éxito S.A. · 31–60 días»). Lista cada partida abierta con su comprobante (enlace), su descripción (la factura que la originó), la fecha, el vencimiento, los días vencidos, el rango, la cuenta y el **saldo abierto**; la suma del pie es el valor en el que hiciste clic. El **Total** de un tercero muestra los documentos que suma el total (sin los por vencer, salvo que el parámetro los incluya); en el detalle, **Rango de días › Todos** sigue la misma regla y **Por vencer** muestra solo los que aún no vencen; el valor de un **Subtotal** en **Moneda del documento** muestra los documentos de esa moneda de todos los terceros. El detalle tiene los mismos parámetros que la cartera (tipo, fecha de corte, moneda), más el tercero y el rango, y se exporta a PDF, Excel o CSV como cualquier informe.

## Cómo se calcula lo pendiente

Depende de si la empresa tiene activo el módulo **Pagos**. Puedes activarlo o desactivarlo en cualquier momento: el informe se recalcula con la regla que corresponda y no se pierde nada.

**Sin Pagos.** Los abonos de un tercero en una cuenta se aplican a sus partidas por orden de vencimiento, la más antigua primero. Un abono mayor que todo lo pendiente no aparece en el informe. La **Conciliación de control** lo muestra como diferencia.

**Con Pagos (cartera de clientes).** Lo pendiente de cada factura es lo que el documento todavía debe:

- **Recibos de caja.** Cada recibo rebaja las facturas a las que lo aplicaste, por el valor aplicado. Ese valor incluye las retenciones que te practicó el cliente. Un abono a la factura más nueva no rebaja la más antigua.
- **Recibo anulado.** Si anulas un recibo, sus facturas vuelven a quedar pendientes desde la fecha de la anulación.
- **Notas.** Una nota crédito rebaja su propia factura. Si la nota acredita más de lo que la factura todavía debía (un reembolso), el sobrante sale en **Anticipos y saldos a favor**: no rebaja otras facturas. Una factura anulada (con su nota crédito de anulación) sale del informe. Una nota débito es una partida más de su factura, con su propio vencimiento: el recibo que pagas a esa factura la cubre también.
- **Anticipos.** Lo que un recibo no aplicó a ninguna factura es un anticipo del cliente (cuenta de anticipos de clientes). No rebaja ninguna factura: sale en **Anticipos y saldos a favor**.
- **Abonos sin recibo.** Un comprobante manual que abona la cuenta del cliente sin recibo de caja se aplica a las partidas más antiguas primero, como sin Pagos. Si sobra, sale como saldo a favor. Así, la suma de las partidas de la cuenta del cliente es siempre su saldo contable.
- **Retenciones que te practicó el cliente.** Quedan en una cuenta de retenciones (por ejemplo 135515) a nombre del cliente, pero no son deuda del cliente: no salen en su fila.
- **Cuentas por pagar.** Se calculan siempre como sin Pagos.
- **Comisiones por pagar.** Cada comisión causada de un vendedor (guía **Comisiones**) es una partida por pagar a nombre de su beneficiario, con el vencimiento de la comisión (su fecha más los días para pagar del plan): la de un empleado en la cuenta de salarios por pagar, la de un agente comercial en la de comisiones por pagar. Una comisión revertida sale del informe.

Si cada recibo se aplica a las facturas más antiguas primero, los dos cálculos dan las mismas partidas de las facturas.

> Sin Pagos, las retenciones que te practicó el cliente sí salen en su fila, como una partida más: quedan en una cuenta del grupo 13 a nombre del cliente.

## Facturas en otra moneda

Si exportas y facturas en dólares (u otra moneda), el parámetro **Moneda** cambia cómo ves esas facturas.

- **Equivalente en COP.** Todo en pesos: una fila por tercero y el total al pie, como siempre. El encabezado dice que los valores van en COP. Una factura en USD vale lo que se contabilizó con su tasa; si corriste la **diferencia en cambio** del mes (guía **Controles contables**), vale a la tasa de cierre hasta el día siguiente al cierre, cuando el ajuste se reversa.
- **Moneda del documento.** Cada factura en su propia moneda. Las filas se agrupan por moneda y cada grupo termina en una fila **Subtotal USD**, **Subtotal COP**, etc. No hay total general: no se suman dólares con pesos.

Lo pendiente en dólares baja con lo que el cliente pagó en dólares (o el equivalente en dólares que digitaste al registrar un pago en pesos) y con las notas crédito de la factura.

## Cobrar lo vencido

1. Ordena por **Más de 90 días** (clic en el encabezado) para ver primero a los más atrasados.
2. Abre el tercero y revisa qué facturas están vencidas.
3. Exporta con **Excel**, **CSV** o **PDF** y compártelo con quien cobra.

## Preguntarle al asistente

«¿Quién me debe más de 90 días?» responde desde este mismo informe, con el enlace a la pantalla.

## Cuentas restringidas

Si tu rol no ve una cuenta de cartera o proveedores, sus partidas no aparecen para ti (guía **Seguridad por cuenta**).
