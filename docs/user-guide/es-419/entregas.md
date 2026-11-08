---
title: "Entregas y devoluciones de venta: despachar, costo de ventas, anular y devolver"
routes:
  - /sales/deliveries
  - /sales/returns
processes:
  - sales.delivery.create
  - sales.delivery.update
  - sales.delivery.ship
  - sales.delivery.void
  - sales.return.create
  - sales.return.receive
  - sales.return.void
  - accounting.period.reopen
  - accounting.posting.retry
---

# Entregas y devoluciones de venta

Una **entrega** es la mercancía de un pedido confirmado que sale de la bodega hacia el cliente. Vive en **Ventas › Documentos › Entregas**, se numera `ENT-…` al grabarla y no lleva valores: lleva productos y cantidades. Al **despacharla**, Inventario descarga las existencias y el sistema contabiliza el **costo de ventas** al costo promedio de la bodega. Una **devolución** (`DEV-…`, en **Ventas › Documentos › Devoluciones**) recibe de vuelta lo que salió en una entrega.

Los listados muestran el número, el pedido o la entrega de origen, el cliente, la fecha, la etapa (**Por despachar** / **Despachada**; **Por recibir** / **Recibida**) y el estado. Un clic en el número abre el documento: sus **Datos** (con enlaces al pedido, la entrega, el cliente y la bodega), sus líneas y los botones de su etapa. Todo esto también lo puedes pedir al **asistente** (guía **El asistente**).

![entrega ENT-1 despachada, con su pedido, su cliente, su bodega y sus líneas](img/entrega-despachada.png)

## Crear una entrega

En un pedido **Confirmado** pulsa **Crear entrega** (guía **Pedidos de venta**), o en **Entregas** pulsa **Nuevo** y elige el **Pedido**: aparecen sus líneas con lo pedido y una casilla **A despachar** por línea. Si no indicas las líneas, la entrega lleva todo lo que falta por entregar del pedido; puedes entregar menos (una **entrega parcial**) e indicar otra bodega o el centro de costo. Nunca se entrega más de lo pedido: el sistema cuenta lo que ya llevan las otras entregas del pedido que no están anuladas, y si te pasas el mensaje dice, línea por línea, cuánto queda.

Puedes pedir al asistente, por ejemplo: «haz la entrega del pedido PED-12 con 2 cafés de 500 g» o «despacha la entrega ENT-4».

## Despachar

Pulsa **Despachar** en una entrega **Por despachar** (grabada). Al despachar:

1. El sistema vuelve a revisar que el cliente y cada producto sigan **listos para facturar**.
2. Revisa las **existencias físicas** de la bodega, no solo la reserva: si una línea no alcanzó a reservarse completa, o lo que hay está reservado para otro pedido, la entrega no se despacha (`existencias negativas`) y el mensaje dice qué producto falta. Una bodega que permite existencias negativas no se revisa.
   Cada línea sale de **una sola ubicación** (o de la bodega sin ubicación): si ninguna tiene toda la cantidad de la línea, aunque entre todas sí alcance, la entrega no se despacha (*la línea sale de una sola ubicación*). Divide la línea en varias entregas o traslada la mercancía a una ubicación. Lo que otra entrega ya despachó y el inventario aún no descargó se cuenta como salido.
3. La entrega queda **Despachada** y ya no cambia. El pedido pasa a **Entregado en parte** o, con la última entrega, a **Entregado**.
4. **Inventario** registra la salida por venta, con la fecha de la entrega, y libera la reserva de lo que salió. Los servicios no mueven existencias.
5. **Costeo** valora la salida al costo promedio y **Contabilidad** registra el asiento de **costo de ventas** (débito costo de ventas con el centro de costo de la entrega, crédito inventarios) en la fecha de la entrega.

Si el mismo despacho llega dos veces (por ejemplo, un reintento), solo hay una salida de inventario y un asiento. Un pedido con entregas ya no se cancela: anula primero sus entregas.

### Si el inventario no pudo descargar la entrega

Inventario descarga la entrega unos instantes después del despacho. Si en ese lapso otra salida se llevó las existencias, Inventario no la descarga y lo avisa: la entrega **vuelve a Grabada** (abierta, editable), el campo **Motivo del rechazo de inventario** dice qué faltó y cuándo, y el pedido vuelve a su estado anterior. Nada queda descargado a medias ni contado como pendiente. Cuando haya existencias, despáchala de nuevo (el motivo se borra), o anúlala.

## Periodo cerrado

Si la fecha de la entrega cae en un **periodo cerrado**, la mercancía sale igual: las existencias se descargan. Lo que queda pendiente es el asiento de costo de ventas, que aparece en **Contabilidad › Pendientes de contabilizar** con el motivo *periodo cerrado*. Para registrarlo, quien tenga el permiso **reabre el periodo** (pide el código de verificación) y **reintenta** el pendiente: el asiento se registra una sola vez.

## Anular una entrega

Anula una entrega con **Anular** en la barra de acciones y un **motivo**. Una entrega sin despachar se anula sin más. Una entrega despachada se anula solo si **nada de ella se ha facturado** (ninguna factura emitida la incluye, aunque se haya emitido hace un instante; ver la guía **Facturas de venta**) y no tiene devoluciones recibidas: las existencias vuelven a la bodega, el costo vuelve a la capa de costo y el asiento de costo de ventas se **reversa**. Si el costo de ventas aún estaba pendiente (periodo cerrado), el pendiente se descarta y no se registra después. El pedido vuelve a **Confirmado** (o **Entregado en parte**) y puedes hacer otra entrega.

### ¿Reservar de nuevo las existencias para el pedido?

Al anular una entrega **despachada**, la barra de acciones pide el motivo y pregunta **«¿Reservar de nuevo las existencias para el pedido?»**, marcada por defecto. La pregunta aparece solo si el pedido sigue abierto (no está cancelado); una entrega sin despachar no la muestra porque no había sacado nada.

- **Con la casilla marcada**: el inventario devuelve las existencias a la bodega y, **solo si alcanzan**, las reserva de nuevo para las líneas del pedido, de modo que otro pedido no se las lleve. Si falta existencia de **algún** producto no se reserva **nada** (nunca queda un pedido reservado a medias) y la entrega anulada lo explica nombrando el producto, lo que se necesitaba y lo que hay.
- **Con la casilla desmarcada**: igual que siempre; las existencias vuelven a la bodega sin quedar reservadas para el pedido.

La anulación **nunca se rechaza** por falta de existencias: lo único que depende de ellas es la reserva. El resultado aparece en la entrega anulada, en **Reserva al anular** (reservado de nuevo, no alcanzaron las existencias, sin permiso para reservar, o no aplica); el inventario lo confirma unos segundos después de anular. Para reservar de nuevo necesitas también el permiso de **reservar existencias** (Inventario); sin él la entrega se anula igual y el resultado dice que no tenías permiso. El asistente y la API anulan sin reservar de nuevo, salvo que se les pida.

Lo **facturado** de una entrega solo baja cuando su factura se **anula** (la DIAN aceptó la nota crédito de anulación): entonces vuelve a **por facturar**. Una **nota crédito parcial** de la factura (una devolución, una rebaja) no cambia lo facturado de la entrega (guía **Facturación electrónica**).

## Devoluciones

En una entrega **Despachada** escribe el **Motivo de la devolución** (por ejemplo, producto averiado) y pulsa **Crear devolución**, o en **Devoluciones** pulsa **Nuevo** y elige la **Entrega**. Si no indicas las líneas, se devuelve todo lo que salió; nunca más de lo que salió, contando las otras devoluciones de la entrega. La devolución se abre **Por recibir**; al pulsar **Recibir**:

- Las existencias vuelven a la bodega y ubicación de donde salieron, al **costo de la salida original** (no al promedio de hoy).
- Contabilidad devuelve ese costo de ventas (débito inventarios, crédito costo de ventas con el centro de costo).

Anular una devolución recibida saca de nuevo esas existencias de la ubicación a la que entraron y reversa su asiento. Si esas existencias ya salieron (por ejemplo, se vendieron), la anulación se rechaza (*existencias negativas*). Si salen justo mientras Inventario procesa la anulación, la devolución **vuelve a Grabada (recibida)** con el **Motivo del rechazo de inventario**, y su asiento no se toca.

## Imprimir y listados

El listado de **Entregas** muestra el número, el pedido, el cliente, la **Bodega**, la fecha, la etapa y el estado; el de **Devoluciones**, también su bodega y el motivo. **Imprimir** (en la barra de acciones) genera el PDF de una entrega o de una devolución con el membrete de la empresa: el número, el cliente, las fechas, la entrega de donde viene (en una devolución) y el motivo, y la tabla de líneas con producto, descripción y cantidad, sin precios.

## Permisos

Cada acción es un permiso del rol: crear, cambiar, despachar y anular entregas; crear, recibir y anular devoluciones. Reabrir un periodo y reintentar pendientes son permisos de Contabilidad.
