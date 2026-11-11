---
title: "Inventario y costos: bodegas, movimientos, traslados, conteos y existencias"
routes:
  - /inventory/warehouses
  - /inventory/locations
  - /inventory/movements
  - /inventory/transfers
  - /inventory/counts
  - /inventory/stock
  - /inventory/lots
  - /inventory/serials
  - /inventory/product-tracking
  - /inventory/lot-trace
  - /costing/layers
  - /costing/missing
  - /costing/landed-costs
  - /costing/settings
processes:
  - inventory.report.lot_trace
  - inventory.warehouse.create
  - inventory.warehouse.update
  - inventory.location.create
  - inventory.location.update
  - inventory.movement.post
  - inventory.movement.void
  - inventory.adjustment.post
  - inventory.relocation.post
  - inventory.transfer.create
  - inventory.transfer.ship
  - inventory.transfer.receive
  - inventory.transfer.void
  - inventory.count.create
  - inventory.count.record
  - inventory.count.apply
  - inventory.count.void
  - inventory.stock_level.consult
  - inventory.lot.create
  - inventory.lot.update
  - inventory.lot.consult
  - inventory.serial.create
  - inventory.serial.update
  - inventory.serial.consult
  - inventory.product_tracking.set
  - inventory.product_tracking.consult
  - costing.cost_layer.consult
  - costing.cost_missing.consult
  - costing.landed_cost.allocate
  - costing.landed_cost.void
  - costing.settings.update
---

# Inventario y costos

El módulo **Inventario** lleva cuánto tienes de cada producto en cada bodega. El módulo **Costos** lleva cuánto vale. Cada entrada, salida, ajuste, traslado o conteo es un documento con número propio. Las existencias cambian solo a través de esos documentos, nunca a mano.

Los dos módulos tienen en su barra superior las secciones **Maestros**, **Documentos**, **Reportes** y **Parámetros**. Abrir, filtrar y exportar los listados funciona igual que en el resto del sistema (guía **Listados**). El ciclo de los registros (Guardar, Anular, Versiones) se explica en la guía **Maestros y documentos** (`maestros-y-documentos.md`).

Solo llevan existencias los productos de tipo **Bien**. Un movimiento que solo nombra servicios no mueve nada, y el sistema lo dice al guardarlo.

## Bodegas y ubicaciones

Están en **Inventario › Maestros**.

1. **Bodegas** › **Nuevo**: escribe el **Código** (por ejemplo `PRIN`) y el **Nombre**. **Dirección** es opcional.
2. **Permite existencias negativas**: si está apagado, se rechaza una salida que deje la bodega por debajo de cero.
3. **Ubicaciones** divide una bodega en estantes o zonas. Elige la bodega al crear la ubicación. Después ya no se puede cambiar.

La empresa tiene además una bodega de tránsito (código `TRANSITO`). El sistema la usa sola para los traslados despachados que aún no se reciben, y no aparece en las listas de los formularios.

## Lotes, seriales y seguimiento por producto

Un producto puede seguirse **por lote** (por ejemplo café con fecha de tostión y de vencimiento) o **por serial** (una unidad con su número, como un molino). Por defecto un producto no tiene seguimiento y todo funciona como siempre.

1. **Inventario › Parámetros › Seguimiento por producto** dice cómo se sigue cada producto: **Sin seguimiento**, **Por lote** o **Por serial**. Para un producto por lote hay tres opciones más:
   - **FEFO**: al vender sale primero el lote que vence antes.
   - **Vencimiento obligatorio**: un lote sin fecha de vencimiento se rechaza.
   - **Bloquea lotes vencidos**: un lote vencido no se vende.
2. Cambiar el seguimiento de un producto pide tu **código de verificación**. Solo se puede cuando el producto **no tiene existencias** en ninguna bodega. Si las tiene, sácalas primero con un ajuste y vuelve a entrarlas con su lote después del cambio. Cambiar solo FEFO, el vencimiento o el bloqueo no pide sacar nada.
3. **Inventario › Maestros › Lotes** lista los lotes. Cada lote es de **un solo producto**. Su **Código** es el que traes del proveedor o escaneas, y no se repite dentro del mismo producto (dos productos sí pueden tener el mismo código). Lleva **Vence**, **Producido** y una **Nota**. Un lote **Bloqueado** queda retenido y no se vende.
4. **Inventario › Maestros › Seriales** lista los seriales. Cada uno es una unidad de un producto por serial, con su número único dentro del producto y, si quieres, el lote al que pertenece. Su **Estado del serial** lo llevan los movimientos: **Disponible** cuando entra, **Despachado** cuando sale, **Dado de baja** en un ajuste. No se cambia a mano.

En las líneas de movimiento, de traslado y de conteo y en **Existencias** se ven las columnas **Lote** y **Serial**. Están vacías en los productos sin seguimiento. El código del lote y el número del serial son enlaces: ábrelos para ver su registro.

### Crear, duplicar y bloquear un lote

Una entrada crea sola el lote nuevo que escribas en su línea. También puedes crearlo antes, por ejemplo para dejar listos los datos del proveedor:

1. **Inventario › Maestros › Lotes** › **Nuevo**.
2. Elige el **Producto**. La lista trae solo los productos que se siguen por lote; si está vacía, primero cambia el seguimiento del producto (más abajo).
3. Escribe o escanea el **Código del lote**. Agrega **Vence**, **Fecha de producción** y una **Nota** si las tienes. Si el producto exige vencimiento, sin **Vence** no se guarda.
4. Pulsa **Guardar**. Se abre el registro del lote.

El producto y el código no cambian una vez guardado el lote. Sí cambian **Vence**, **Fecha de producción**, **Estado del lote** y la **Nota**.

- **Duplicar** (en la barra del registro) abre un lote nuevo con el mismo producto, las mismas fechas y la nota. Solo escribe el código nuevo y guarda.
- **Bloquear un lote**: abre el lote, cambia **Estado del lote** a **Bloqueado** y pulsa **Guardar**. Un lote bloqueado no se vende: FEFO lo salta. Para liberarlo, vuelve a ponerlo **Activo**.

### Registrar un serial

Una entrada registra sola los seriales nuevos de sus líneas. Para registrar uno antes:

1. **Inventario › Maestros › Seriales** › **Nuevo**.
2. Elige el **Producto** (solo los que se siguen por serial) y escribe o escanea el **Número de serie**. Si el producto tiene lotes, puedes elegir el **Lote**.
3. Pulsa **Guardar**.

En el registro del serial solo cambia la **Nota**. Su **Estado del serial** lo llevan los movimientos: un serial registrado así queda en existencia solo cuando una entrada, un ajuste o un conteo lo recibe.

### Cambiar el seguimiento de un producto

1. **Inventario › Parámetros › Seguimiento por producto** › **Nuevo** para un producto que aún no está en la lista, o abre su fila para cambiarlo.
2. Elige el **Producto** y el **Seguimiento**: **Sin seguimiento**, **Por lote** o **Por serial**. Prende o apaga **FEFO**, **Vencimiento obligatorio** y **Bloquear lotes vencidos**.
3. Pulsa **Guardar**. El sistema pide tu **código de verificación** (el segundo factor) y guarda.

Si el producto tiene existencias, el cambio de seguimiento se rechaza con el mensaje «El producto tiene existencias (…): sácalas antes de cambiar su seguimiento». Saca las existencias con un ajuste, cambia el seguimiento y vuelve a entrarlas con su lote o sus seriales. FEFO, el vencimiento obligatorio y el bloqueo sí cambian con existencias.

### Lotes y seriales en entradas, salidas, traslados, ajustes y conteos

Las existencias de un producto con seguimiento se llevan **por lote** o **por serial** dentro de cada bodega y ubicación. Al elegir un producto con seguimiento en una línea aparece la columna **Lote / seriales**.

- **Entrada.** Un producto por lote pide el **Código del lote**. Si el código es nuevo, el lote se crea solo al guardar, con el **Vencimiento** que escribas; si el producto exige vencimiento, sin fecha no se guarda. Si el lote ya existe, la entrada se suma a él (el código no distingue mayúsculas). Un producto por serial pide **un serial por unidad**, separados por comas: 3 unidades, 3 seriales. Cada serial nuevo se registra solo y queda **Disponible**. Un serial que ya está disponible no vuelve a entrar.
- **Salida.** Indica el lote o los seriales que salen. Si el lote no tiene esa cantidad en la bodega y ubicación, la salida se rechaza, aunque la bodega permita existencias negativas. Un serial que no está en esa bodega y ubicación tampoco sale. El serial que sale queda **Despachado**; si vuelve con una entrada, queda **Disponible** otra vez.
- **Traslado.** Cada línea dice el lote o los seriales que viajan. Al despachar y al recibir se mueve el mismo lote o serial, también mientras está en tránsito.
- **Ajuste.** Sigue pidiendo tu código de verificación. Cada línea dice su lote o sus seriales. Un ajuste negativo de un serial lo deja **Dado de baja**. Un ajuste positivo con un serial nuevo lo registra y lo deja disponible.
- **Conteo.** Al crear el conteo, un producto con seguimiento sale en la hoja **una línea por lote o serial** con existencias en esa ubicación. Cuenta cada lote; en un serial pon 1 si lo encontraste y 0 si falta. Lo que encuentres y no esté en la hoja (un lote nuevo, un serial escaneado) se agrega con **Agregar encontrado** (ver **Conteos físicos**). Al aplicar, cada diferencia es una línea del ajuste: un lote con 2 de menos, un lote nuevo con lo encontrado, un serial que falta con −1 (queda dado de baja).

Si la línea no dice el lote o los seriales, o los seriales no coinciden con la cantidad, el formulario lo dice al pie antes de guardar.

## Movimientos: entradas, salidas y ajustes

Ve a **Inventario › Documentos › Movimientos** › **Nuevo**.

1. Elige el **Tipo**:
   - **Entrada**: suma existencias. Cada línea lleva su **Costo unitario**.
   - **Salida**: resta existencias.
   - **Ajuste**: escribe la cantidad con signo (+ suma, − resta).
2. Elige la **Bodega**. Por cada línea, el **Producto** (escribe parte del código o del nombre), la **Ubicación** si la bodega tiene ubicaciones, y la **Cantidad**.
3. En un ajuste, escribe el **Motivo** (merma, sobrante, daño).
4. Pulsa **Guardar**. Al pie, el formulario dice qué falta.

Un **ajuste** te pide tu **código de verificación** (la app de autenticación) antes de guardarse. Contabilidad lo registra con el costo de cada producto. En el registro del ajuste, la pestaña **Contabilidad** muestra su comprobante.

Las entradas se numeran `EN-…`, las salidas `SA-…` y los ajustes `AJ-…`. Un movimiento guardado no se edita. Si hubo un error, usa **Anular** en la barra del registro.

### Reubicaciones

Una **reubicación** (`RU-…`) mueve existencias de una ubicación a otra **de la misma bodega**: no cambia cuánto hay en la bodega ni lo que vale, y no genera comprobante contable. Cada línea reubicada aparece dos veces: con cantidad negativa en la ubicación de donde sale y positiva en la de destino, con su mismo lote o serial. Las crea sola la **ubicación de lo recibido** del módulo Bodega (ver [Bodega](bodega.md)). Entre bodegas distintas no se reubica: se usa una transferencia. Una reubicación no se anula; si quedó mal, se corrige con otra reubicación.

## Transferencias entre bodegas

**Inventario › Documentos › Transferencias** › **Nuevo**.

1. Elige la **Bodega de origen**, la **Bodega de destino** (debe ser distinta) y las líneas con su cantidad.
2. Pulsa **Guardar**. El traslado queda **Solicitado** y todavía no mueve nada.
3. Cuando la mercancía sale, abre el traslado y pulsa **Despachar**. Las cantidades pasan a la bodega de tránsito y el traslado queda **En tránsito**.
4. Cuando llega, pulsa **Recibir**. Las cantidades entran a la bodega de destino y el traslado queda **Recibido**.

## Conteos físicos

**Inventario › Documentos › Conteos** › **Nuevo**: elige la bodega y los productos que vas a contar, y pulsa **Guardar**. El conteo guarda lo que el sistema tiene en ese momento.

1. En la **Hoja de conteo**, escribe lo **Contado** por línea y pulsa **Registrar conteo**. Puedes hacerlo por partes. La columna **Diferencia** muestra contado menos sistema.
2. Cuando todas las líneas estén contadas, pulsa **Aplicar conteo**. El sistema pide tu **código de verificación** y registra todas las diferencias como **un solo ajuste**.
3. El conteo queda **Aplicado** y enlaza a su ajuste. Abre el ajuste para ver su comprobante en la pestaña **Contabilidad**.

### Agregar lo encontrado

En un conteo abierto, la hoja lista los lotes y seriales que el sistema tiene. Si encuentras algo que no está en la hoja, pulsa **Agregar encontrado** debajo de ella:

1. Elige el **Producto** (debe seguirse por lote o por serial; un producto sin seguimiento se agrega al crear el conteo) y, si la bodega tiene ubicaciones, la **Ubicación**.
2. Un producto por lote: elige uno de sus lotes o deja **Lote nuevo…** y escribe el **Código del lote** con su **Vencimiento**. Escribe la **Cantidad contada**.
3. Un producto por serial: escanea o escribe el **Serial**. La cantidad es 1. El lector termina con Enter, que abre otra fila del mismo producto para el siguiente serial.
4. Pulsa **Registrar conteo**. Lo encontrado pasa a ser una línea de la hoja, con su lote o serial. Un lote nuevo se crea y un serial nuevo se registra en ese momento.

Si algo no se puede registrar, el motivo aparece debajo de su fila: el producto exige lote o vencimiento, el serial ya está en existencia en otra parte (muévelo con un traslado o cuéntalo donde está), o ese lote ya está en la hoja (escribe lo contado en su línea). Al **Aplicar conteo**, lo encontrado entra como una línea positiva del ajuste en su lote.

## Trazabilidad de lotes (retiro del mercado)

**Inventario › Reportes › Trazabilidad de lotes** responde «¿a quién le vendimos este lote?». Elige un **Lote** (o un **Serial**, no los dos) y, si quieres, un rango **Desde / Hasta**. El reporte lista, del más antiguo al más reciente, cada movimiento que movió ese lote o serial:

- **Fecha**, **Tipo** (Entrada, Salida por venta, Devolución de venta, Traslado, Ajuste…), **Bodega** y **Cantidad** (negativa cuando sale).
- **Número**: el movimiento de inventario; ábrelo para llegar a la entrega o devolución que lo originó. **Documento** es el número de ese documento de origen (la entrega, la devolución o la referencia de la entrada).
- **Cliente**: a quién se le entregó o quién lo devolvió. Lo guarda el propio movimiento al despachar la entrega y al recibir la devolución, así que no cambia si después editas el pedido. Si tu rol no puede ver el cliente del movimiento, la columna sale vacía.

Sobre el reporte aparece el lote o el serial elegido; su código es un enlace a su registro.

Al final, una fila **Existencia** por bodega que todavía tiene ese lote o serial (el rango de fechas no la cambia: es la de hoy). Exporta el reporte a PDF, Excel o CSV con los botones de siempre. El asistente también lo consulta: pregúntale, por ejemplo, «¿A qué clientes fue el lote L-2311?».

En la demostración, **Café molido tradicional 500 g** se sigue por lote (L-2311 vence primero, L-2402 después) y el **Molino de café eléctrico** por serial (MOL-0001 a MOL-0003); la entrega a Distribuciones Andinas del Café salió por FEFO en los dos lotes.

## Existencias

**Inventario › Reportes › Existencias** muestra cuánto hay de cada producto por bodega y ubicación, con la fecha del último cambio. Filtra por producto o bodega, o exporta a Excel. Los datos que tu rol no puede ver salen ocultos.

![Existencias por producto y bodega](img/existencias.png)

## Costos

El detalle del costeo (cómo se calcula el promedio ponderado, qué hace un costo en destino y cómo se resuelven los costos pendientes) está en la guía **Costos** (`costos.md`).


- **Costos › Reportes › Capas de costo**: el costo de cada entrada. Con el promedio ponderado, cada entrada recalcula el costo promedio del producto.
- **Costos › Reportes › Costos pendientes**: salidas de productos que aún no tienen costo, por ejemplo cuando sale mercancía antes de registrar su entrada. Se resuelven solas cuando llega la entrada. Mientras tanto, revisa esta lista antes de cerrar el mes.
- **Costos › Documentos › Costos en destino**: suma al costo de una entrada lo que se pagó después por traerla (flete, aranceles, seguro).
  1. Pulsa **Nuevo**.
  2. Elige la **Entrada de mercancía** y escribe el **Valor**.
  3. En **Repartir por**, elige **Valor** o **Cantidad**.
  4. Elige la **Contrapartida**. Si es una cuenta por pagar o un anticipo, elige también el **Proveedor**.
  5. Pulsa **Guardar**. Pulsar dos veces no lo registra dos veces.

  Anular un costo en destino pide tu código de verificación.
- **Costos › Parámetros › Costeo**: el **Método** de costeo de la empresa. Hoy es **Promedio ponderado**; PEPS (FIFO) llega en la fase 3, y el sistema lo rechaza si lo eliges. **Guardar** pide tu código de verificación.

## Preguntas frecuentes

- **«No encuentro la bodega de tránsito»**: no se elige en los formularios. La usan solo los traslados despachados.
- **«Aplicar conteo está gris»**: falta registrar lo contado en alguna línea.
- **«El ajuste no aparece en contabilidad»**: el comprobante se crea al guardar el ajuste. Si contabilidad aún no tiene cuentas para el inventario, el sistema lo rechaza y dice qué falta. Consulta la guía **Reglas contables**.
