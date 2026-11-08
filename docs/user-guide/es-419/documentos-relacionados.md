---
title: "Documentos relacionados: de dónde viene un documento y qué salió de él"
routes:
  - /crm/quotes
  - /sales/orders
  - /sales/deliveries
  - /invoicing/invoices
  - /payments/receipts
  - /payments/advance-applications
processes:
  - kernel.document_link.trail
---

# Documentos relacionados: de dónde viene un documento y qué salió de él

Una venta pasa por varios documentos: la **cotización**, el **pedido**, la **entrega**, la **factura** y el **recibo de caja**. En cada uno de ellos, la pestaña **Documentos relacionados** te muestra la cadena completa, para que no tengas que buscar un documento en cada listado.

## Dónde está la pestaña

Abre cualquier cotización, pedido, entrega, factura o recibo. Si el documento tiene otros documentos relacionados, aparece la pestaña **Documentos relacionados** con un número: cuántos documentos encontró el sistema, incluidos los que tu rol no puede ver (más abajo). Si el documento no tiene ninguno, la pestaña no aparece.

## Cómo leer la lista

La lista tiene dos partes, siempre en este orden:

- **Origen**: los documentos de los que viene este. En una factura: la entrega, el pedido y la cotización.
- **Derivados**: los documentos que salieron de este. En una cotización: el pedido, la entrega, la factura y el recibo.

Cada renglón dice qué tipo de documento es, su número y el paso que lo une con el anterior (por ejemplo **Pedido → Entrega**). Un documento más lejano se muestra con sangría: el recibo de una factura que viene de un pedido aparece más adentro que la factura. Cada número es un enlace: al hacer clic abres ese documento, y con **Ctrl** o **⌘** lo abres en otra pestaña del navegador.

Los pasos que se relacionan son: Cotización → Pedido, Pedido → Entrega, Entrega → Factura, Pedido → Factura (una factura creada sobre el pedido, sin entrega), Factura → Recibo y, cuando un anticipo se aplica a una factura, **Factura → Aplicación de anticipo** y **Recibo → Aplicación de anticipo** (la aplicación de anticipo AP-n que une el recibo del anticipo con la factura que saldó; guía **Pagos de clientes**). Una cotización que se pidió dos veces (porque el primer pedido se canceló) muestra los dos pedidos; una factura de dos entregas muestra las dos.

## «Anulado»

Si un documento se anula (un pedido cancelado, una entrega anulada, una factura anulada, un recibo anulado), la relación **no desaparece**: el documento anulado sigue en la lista, **tachado** y con la etiqueta **Anulado**. Solo se marca el documento que se anuló: los documentos vigentes que están junto a él (la cotización de un pedido cancelado, la factura de un recibo anulado) siguen sin marca. Así ves qué pasó con la cadena. Un documento anulado no se vuelve a activar.

## «Y N documentos más que no puedes ver»

Si algún documento de la cadena es de otro vendedor, es de un tipo que tu rol no puede consultar o tiene acceso restringido, **no se muestra su número ni de qué tipo es**. Debajo de la lista aparece solo cuántos son: **Y 2 documentos más que no puedes ver**. Es un aviso de que la cadena sigue; para ver esos documentos pide el permiso al administrador de tu empresa (guía [Administración de la empresa](administracion.md)).

Un documento que no puedes ver no corta la cadena: si ves la cotización y el recibo pero no la factura que los une, ves los dos y se cuenta la factura. Eso sí, el renglón del documento que está al otro lado de uno oculto no trae el nombre del paso, porque nombrarlo diría qué es el documento oculto.

## Límites

- La lista llega hasta **6 niveles** desde el documento que abriste y muestra hasta **100 documentos**. Si hay más, al final dice **Se muestran los primeros 100** (o el número que se alcanzó). Para ver el resto, abre un documento de la lista y consulta su propia pestaña.
- Cuando el tope se alcanza hacia atrás (Origen) y el documento tiene también derivados, la lista de Derivados puede no aparecer: el tope de documentos se agota antes. En ese caso el aviso **Se muestran los primeros** lo indica; abre un documento de Origen para seguir hacia adelante.

## Quién puede verla

La pestaña la tiene todo rol: no pide un permiso aparte. Lo que muestra depende de lo que tu rol puede consultar en cada documento (guías [Cotizaciones](cotizaciones.md), [Pedidos de venta](pedidos.md), [Entregas y devoluciones](entregas.md), [Facturas de venta](facturacion.md) y [Pagos de clientes](pagos.md)); un documento que ya existía antes de esta pestaña también aparece, porque el sistema reconstruyó sus relaciones.
