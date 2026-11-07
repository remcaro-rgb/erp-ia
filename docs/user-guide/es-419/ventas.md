---
title: "Ventas: precios y condiciones comerciales"
routes:
  - /sales/customer-terms
  - /sales/settings
processes:
  - sales.customer_terms.set
  - sales.settings.update
  - sales.price.resolve
  - sales.discount.resolve
---

# Ventas: precios y condiciones comerciales

El módulo **Ventas** decide el precio de cada línea de lo que vendes (cotizaciones y, más adelante, pedidos y facturas). Las **listas de precios** son las de **Núcleo** (un precio por producto y lista); Ventas dice qué lista usa cada cliente y cuál usan los demás.

Las dos pantallas están en **Ventas › Parámetros**: **Condiciones comerciales** y **Parámetros de ventas**. Cada una guarda con su botón **Guardar** y muestra **Guardado** al terminar; si algo no se acepta, el mensaje dice por qué. También puedes pedirlo al **asistente** (guía **El asistente**), que ejecuta las mismas acciones con tus permisos y te pide confirmar cada cambio.

En **Ventas › Documentos** también encuentras un acceso a **Cotizaciones**. Las cotizaciones siguen siendo de **CRM** (guía **Cotizaciones**): el acceso abre la misma pantalla y solo aparece si tu empresa tiene CRM y puedes verla.

## De dónde sale el precio

Para un producto y un cliente, el sistema busca en este orden y usa el primero que tenga precio:

1. La **lista de precios del cliente** (sus condiciones comerciales).
2. La **lista de precios predeterminada** de la empresa.
3. El **precio de lista** del producto (su ficha en **Productos**).

Una lista inactiva, sin aprobar (si requiere aprobación) o en otra moneda que el documento no se usa. Si ninguna da precio, el sistema lo dice y escribes el precio a mano; el descuento habitual del cliente se aplica igual. Un precio escrito a mano en la línea siempre gana. Puedes preguntar al asistente «¿a qué precio le vendo el café de 500 g a Distribuidora Andina?» y te responde con el precio, la lista de donde sale y el descuento.

## Condiciones comerciales de un cliente

**Ventas › Parámetros › Condiciones comerciales**: el listado muestra los clientes que ya tienen condiciones propias (lista, descuento, cupo y notas). Debajo, en **Fijar condiciones de un cliente**, elige el **Cliente** (debe ser un tercero de tipo cliente), su **Lista de precios** y su **Descuento habitual (%)**, y pulsa **Guardar**. El descuento habitual se propone en cada línea que no traiga uno propio; puedes cambiarlo en la línea. Quitar la lista deja al cliente con la lista predeterminada. El **Cupo de crédito** (en pesos) es lo máximo que el cliente puede tener en pedidos confirmados sin aprobación; vacío, no tiene tope (guía **Pedidos de venta**). Al cambiar un solo dato, los demás se conservan.

![Condiciones comerciales: el listado de clientes con condiciones propias y, debajo, Fijar condiciones de un cliente](img/condiciones-comerciales.png)

## Parámetros de ventas

**Ventas › Parámetros › Parámetros de ventas**: la **Lista de precios predeterminada**, la que da el precio a los clientes sin lista propia o cuando su lista no trae el producto. Debe estar activa (y aprobada, si las listas requieren aprobación). Sin lista predeterminada, se usa el precio de lista del producto. El **Descuento máximo de un pedido sin aprobación (%)**: un pedido con una línea de descuento mayor espera aprobación; vacío, ningún pedido la espera por su descuento.

Las cotizaciones que usan estos precios se explican en la guía **Cotizaciones**; los pedidos, en la guía **Pedidos de venta**.

## El PDF de una entrega

En pantalla el documento se llama **Entrega** (prefijo **ENT-**). Al **Imprimir** una entrega, el PDF lleva como título **Remisión de entrega**, el nombre que usan los clientes y transportadores para este documento. El PDF no trae precios: es lo que salió de la bodega. Si tu empresa definió su propia plantilla de impresión para las entregas, se usa esa y su título.
