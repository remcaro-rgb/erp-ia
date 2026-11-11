---
title: "Comisiones: planes, comisiones y comisiones por vendedor"
routes:
  - /sales/commission-plans
  - /sales/commissions
  - /sales/reports/commissions
processes:
  - sales.commission_plan.create
  - sales.commission_plan.update
  - sales.commission_plan.consult
  - sales.commission.consult
  - sales.commission.consult_all
  - sales.report.commissions
---

# Comisiones: planes, comisiones y comisiones por vendedor

Las comisiones de los vendedores se calculan solas a partir de las facturas que vienen de sus pedidos. Esta guía explica dónde se crea un plan, dónde ves cada comisión y el informe **Comisiones por vendedor**. Cómo se causa, se contabiliza y se revierte una comisión está en la guía **Ventas: precios y condiciones comerciales**.

## Crear un plan de comisión

1. **Ventas › Maestros › Planes de comisión** y pulsa **Nuevo**.
2. Escribe el **Nombre** del plan.
3. En **Tipo de beneficiario** elige **Empleado** o **Agente comercial**. En **Beneficiario** busca el tercero al que se le paga: un tercero de tipo empleado para un empleado, de tipo proveedor para un agente. Debe estar listo para facturar (sus datos DIAN y sus archivos completos).
4. Escribe la **Tasa general (%)**, entre 0 y 100 (acepta coma o punto: 5,5).
5. Los **Días para pagar** (30 si no los cambias) dan el vencimiento de la cuenta por pagar de cada comisión.
6. **Vigente desde** es hoy si no la cambias. **Vigente hasta** vacía deja el plan sin fin.
7. En **Vendedores** marca los usuarios cuyos pedidos comisionan bajo este plan. Un usuario está en un solo plan activo en cada fecha: si ya tiene otro que se cruza, el plan no se guarda y el mensaje lo dice.
8. En **Tasas por categoría** pulsa **Agregar categoría** para cada categoría de producto que gana distinto de la tasa general (por ejemplo, «Café molido» al 7 %). Una categoría va una sola vez.
9. Pulsa **Crear** (o Ctrl+S).

Para cambiar un plan, ábrelo desde el listado, cambia lo que necesites y pulsa **Guardar**. El cambio vale para las facturas que se emitan después: la base y la tasa de cada línea quedan fijas al emitir la factura. Para que un plan deje de comisionar, apaga **Activo** o ponle **Vigente hasta**.

También puedes pedírselo al **asistente** («crea un plan de comisión del 5 % para Bruno»): te muestra el plan y te pide confirmar antes de crearlo.

## Cuándo se gana la comisión

**Ventas › Parámetros › Parámetros de ventas**, casilla **Base de comisión**:

- **Al recaudo** (la opción inicial): cada recibo de caja o anticipo aplicado a la factura causa la parte de la comisión que pagó.
- **Al facturar**: al emitir la factura se causa toda la comisión.

La opción vale para las facturas que se emitan después de guardarla.

## Las comisiones

**Ventas › Documentos › Comisiones**: cada comisión (prefijo **COM-**) con su beneficiario, su plan, de dónde viene (la factura o el recibo que la causó), la fecha, el vencimiento, el valor y su estado: **Causada**, **Reversada** (por una anulación, una nota crédito o un recibo anulado) o **Pagada**. Al abrir una ves sus líneas: cuánto causó de cada línea de factura. Las comisiones no se escriben a mano: las crea el sistema. Al **Imprimir** una comisión sale su PDF con el beneficiario, el plan, el valor y sus líneas.

## Comisiones por vendedor

**Ventas › Reportes › Comisiones por vendedor**. Elige el periodo (**Desde** y **Hasta**, por la fecha de la factura), si quieres un **Beneficiario** y el **Estado**: **Todas**, **Abiertas** (la factura sigue vigente) o **Cerradas** (la factura se anuló). Pulsa **Consultar**.

Cada fila es una línea de factura que comisiona: el beneficiario, el plan, la factura, el producto, la **Base** (el subtotal de la línea en pesos), la **Tasa**, la **Comisión** (base por tasa), lo **Causado**, lo **Reversado** y lo que falta **Por causar**. Al recaudo, una factura cobrada en parte tiene comisión por causar; cuando se salda, por causar queda en cero. El pie suma cada columna de valores. Desde el informe se abre la factura, el plan o el tercero, y se exporta a PDF, Excel o CSV como cualquier listado.

La cuenta por pagar de cada comisión sale también en **Cartera y cuentas por pagar por edades**, en **Por pagar**, a nombre del beneficiario y con su vencimiento.

## Quién ve qué

- Un vendedor ve solo los planes que lo incluyen y sus comisiones.
- Quien tiene el permiso **Ver las comisiones de todos los vendedores** (en **Administración › Roles**) ve todas. En la demostración lo tienen el administrador, el gerente comercial y el contador.
- Las tasas y los valores son confidenciales: un rol que no ve datos confidenciales los ve ocultos, y el informe no suma una columna que no puede ver.
