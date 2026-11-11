---
tags: [2b2, ventas, inventario, rls, decision]
date: 2026-11-09
status: implemented
---
# Decisiones del dueño 111-119, lote M2 (2B.2)

Sigue a [[Revisión completa de la rama 2B.2]]; el recorrido de la reserva está en [[Anular entrega y reservar de nuevo (2B.2 task 43)]].

- **Items 57 / 113**: la semilla apaga Pagos con `disableModule` (nuevo en el resolver del kernel, gemelo de `kernel.admin.module.disable`) en vez de un insert crudo en `kernel.company_modules`. Solo demo; la regla real (FIFO) es de 2C.
- **119(a)**: `sales.return.*` bloquea primero el pedido de la entrega (`for update` bajo RLS), como `delivery.ts`: un vendedor no devuelve contra el pedido de otro.
- **119(b)**: migración 0146. El aprobador sigue leyendo (política `owner_scope` de 0140) pero escribe solo pedidos pendientes (`owner_scope_write` / `owner_scope_delete`, `with check` con la regla de lectura). `cancelOrder` fija la etapa antes de anular y `outputOf` ya no bloquea: una escritura silenciosa de 0 filas tras salir de pendiente dejaba la cancelación a medias.
- **119(c)**: `inventory.reservation.reserve_again` devuelve a cada línea lo que su reserva liberó al despachar (restaura `released_qty`, reactiva la fila liberada) en vez de sumar lo despachado; sin reserva, nada.
- **119(d)**: sin código; dicho en la guía de facturación electrónica.

## Lote K2 (kernel) y re-revisión
- **111**: el despachador deja en dead letter `not_entitled:<módulo>` el evento de un módulo nunca contratado que tiene proveedor de contabilización (Contabilidad escucha `"*"`, así que se aparcan todos los eventos no `kernel.*`); al comprarlo, el barrido los reproduce. Ver [[Modo de contabilización (2B.2 task 33)]].
- **119(e)**: migración 0145, columna `parked_module` en el dead letter (con backfill), para que un fallo posterior no esconda el evento del barrido.
- **112**: una arista `needs` no bloquea apagar un módulo que `dependsOn` del que lo necesita: Costos se apaga con Inventario encendido. Guías `costos.md` y `administracion.md` corregidas.
- **Re-revisión**: 0 Critical, 1 Important (R-1: el reorden de `cancelOrder` hacía que «Anular» desde la ficha respondiera siempre `stale_record`; corregido validando `expectedUpdatedAt` en el bloqueo inicial), 7 Minor listados.
- Decisiones registradas en el diseño §22.29 ([[Owner Decisions]]).

## Lección
- Escribir sobre la fila antes de la acción que valida `expectedUpdatedAt` dispara el trigger `touch_row` y rompe la concurrencia optimista: valida al bloquear, no después.
