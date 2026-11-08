---
title: "Visibilidad de pedidos: quién ve cada pedido y «Cambiar vendedor»"
routes:
  - /sales/orders
processes:
  - sales.order.reassign
  - sales.order.create
  - sales.order.from_quote
  - sales.order.approve
  - sales.order.consult
  - kernel.admin.permission.set_many
---

# Visibilidad de pedidos: quién ve cada pedido

Cada **pedido de venta** tiene un **Vendedor**: la persona a la que pertenece. Un vendedor ve y trabaja **solo sus propios pedidos**; quien tiene el permiso **Cambiar vendedor** ve **todos** los pedidos de la empresa. Es la misma idea que ya tienen las cotizaciones y las oportunidades de CRM (guía [CRM](crm.md)).

## Quién ve qué

- **Un vendedor** ve en **Ventas › Documentos › Pedidos** solo los pedidos donde él es el **Vendedor**. Si abre por la dirección el pedido de otro, el sistema responde **No encontrado**; si lo busca con ⌘K o lo pide al asistente, tampoco aparece. Los totales de **Inicio** (por ejemplo **Pedidos abiertos**) cuentan solo los suyos, y lo mismo vale para los informes y las exportaciones. Tampoco le llegan los avisos de **Inicio** y de la campana sobre el pedido de otro (por ejemplo **No se creó la factura automática**): esos los ven solo quienes pueden ver ese pedido.
- **Quien puede cambiar vendedor** (el administrador de la empresa siempre puede) ve todos los pedidos, también los que **no tienen vendedor**.
- **Quien puede aprobar pedidos** (cupo de crédito o descuento, guía [Pedidos de venta](pedidos.md)) ve además los pedidos que **piden o pidieron aprobación**, de cualquier vendedor (también después de aprobarlos o no aprobarlos); los demás pedidos de otros vendedores no.
- Un **pedido sin vendedor** (por ejemplo, uno creado por un proceso automático) solo lo ven quienes pueden cambiar vendedor. Es distinto de las cotizaciones: una cotización sin vendedor la ven todos.

El **Vendedor** aparece en los datos del pedido y como columna del listado, donde puedes filtrar por él. Si tu rol no ve ese campo, lo ves enmascarado (••••) o no aparece (—), según cómo lo configuró el administrador. En el listado, ordenar por **Vendedor** ordena por el identificador interno del usuario, no por el nombre; para encontrar a alguien usa el filtro.

## Cómo dar el permiso «Cambiar vendedor»

El permiso es el proceso **Cambiar el vendedor de un pedido**. Se da en **Administración › Permisos**: busca ese proceso en la matriz, marca la casilla del rol y pulsa **Aplicar cambios** con tu código. Quien lo tiene ve todos los pedidos y puede reasignarlos.

- Al activar esta función, los roles que ya podían **reasignar oportunidades**, **crear o despachar entregas** o **crear facturas desde pedidos** o **emitirlas** recibieron el permiso, para que bodega, facturación y gerencia no pierdan de vista los pedidos que trabajan. Los roles que solo venden (cotizaciones y pedidos) conservan solo lo propio.
- Los roles y las empresas que crees después **no lo traen**: el administrador lo marca cuando haga falta.
  Por eso, un rol de bodega o de facturación creado después recibe **No encontrado** al **Despachar** o **Emitir** algo del pedido de otro vendedor, hasta que el administrador le marque **Cambiar el vendedor de un pedido** (el permiso de ver todos los pedidos).

## De quién es un pedido nuevo

- Un pedido que **creas directamente** es tuyo.
- Un pedido que sale de una **cotización aceptada** (**Crear pedido**) queda con el vendedor **de la cotización**, no con quien pulsó el botón. Si la cotización no tenía vendedor, queda con quien la convirtió.
- Si quien convierte no es el vendedor de la cotización y tampoco puede cambiar vendedor, no podría ver el pedido que acaba de crear. El sistema no lo abre: muestra **Pedido creado, asignado a** y el nombre del vendedor, y el pedido es de ese vendedor.

## Cambiar vendedor

1. Abre el pedido (cualquier etapa, también uno entregado o cancelado).
2. Pulsa **Cambiar vendedor** (solo lo ves si tienes el permiso).
3. Elige al nuevo **Vendedor** de la lista de usuarios de la empresa y pulsa **Asignar**. Un aviso confirma: **Pedido asignado a …**.

El pedido pasa a ver y trabajarlo el nuevo vendedor, y el anterior deja de verlo si no puede cambiar vendedor. Si eliges al vendedor que ya tiene el pedido, no cambia nada. La auditoría guarda quién lo cambió, de quién a quién y cuándo. Un usuario que no pertenece a la empresa se rechaza con **El vendedor no pertenece a la empresa**.

## Entregas y facturas de los pedidos de otros

Las **entregas** y las **facturas** **no** se limitan por el vendedor del pedido: bodega y facturación las necesitan sin importar de quién es el pedido, y las ven los roles que ya las consultaban. Lo que cambia es lo que muestran del pedido:

- Si el pedido **no es tuyo**, la entrega y la factura escriben **Pedido no disponible**, sin número, sin identificador y sin enlace: también en los listados de **Entregas** y **Devoluciones** y en la pestaña **Versiones** de la entrega, la devolución y la factura. (Exportar un listado de entregas conserva el identificador del pedido de la propia entrega.) En **Documentos relacionados** ese pedido se cuenta en «documentos que no puedes ver» (guía [Documentos relacionados](documentos-relacionados.md)).
- Si el pedido **sí lo ves**, lo ves con su enlace. La **entrega** muestra además el **Vendedor del pedido**, y la **factura** lo muestra por cada pedido que factura (**Vendedor del pedido**).

Las acciones automáticas (reservar existencias al confirmar, la factura automática, la contabilización) las hace el sistema por la empresa y no dependen de este permiso.

## Si algo no coincide

- «No veo un pedido que sé que existe»: puede ser de otro vendedor. Pide a quien lo tiene, o a un administrador, que lo reasigne o que te dé el permiso.
- «Veo la factura pero no el pedido»: es lo esperado cuando el pedido es de otro vendedor.
- «Después de convertir una cotización de otro vendedor, **Crear pedido** sigue ofreciéndose»: ya tiene su pedido, así que el sistema lo rechaza al pulsarlo.
- «No encuentro el botón **Cambiar vendedor**»: tu rol no tiene el permiso.
