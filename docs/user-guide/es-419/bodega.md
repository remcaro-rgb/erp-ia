---
title: "Bodega: alistamiento, empaque y ubicación de lo recibido"
routes:
  - /warehouse/parametros/plantillas
  - /inventory/movements
processes:
  - warehouse.pick.create
  - warehouse.pick.update
  - warehouse.pick.start
  - warehouse.pick.confirm
  - warehouse.pick.void
  - warehouse.settings.update
  - warehouse.pack.create
  - warehouse.pack.update
  - warehouse.pack.close
  - warehouse.pack.void
  - warehouse.putaway_rule.create
  - warehouse.putaway_rule.update
  - warehouse.putaway_rule.delete
  - warehouse.putaway.suggest
  - warehouse.putaway.confirm
  - inventory.relocation.post
---

# Bodega

El módulo **Bodega** ordena el trabajo físico de la bodega en tres pasos: **alistar** lo que sale en un pedido, **empacarlo** en paquetes con su lista de empaque, y **ubicar** en los estantes lo que llega en una entrada. Funciona sobre el módulo **Inventario**: las existencias siguen cambiando solo con sus documentos. Las pantallas propias de Bodega (menús **Bodega › Documentos** y **Bodega › Parámetros**) llegan en una próxima entrega; mientras tanto estos pasos se hacen con el asistente o desde las acciones del registro.

## Alistamiento

Un **alistamiento** (`ALI-…`) es la lista de lo que hay que tomar de la bodega para un pedido confirmado, con la **ubicación**, el **lote** y el **serial** propuestos para cada línea.

- Si en **Parámetros de bodega** está activo **Crear el alistamiento al confirmar el pedido**, el alistamiento se crea solo al confirmar el pedido. Si no, se crea a mano.
- El alistador **empieza** el alistamiento, anota lo que tomó de cada línea (ubicación, lote, seriales) y lo **confirma**. Confirmar no mueve existencias: Inventario **asigna** a la reserva del pedido lo que se tomó.
- Si la asignación alcanza y está activo **Crear la entrega al confirmar el alistamiento**, aparece sola la entrega del pedido con lo alistado (ver [Entregas](entregas.md)). Si alguna línea no alcanzó, el alistamiento vuelve a **En proceso** para corregirlo.
- Si el pedido se cancela, sus alistamientos se anulan solos.

## Empaque

Un **empaque** (`EMP-…`) reparte lo alistado en **paquetes**, con su peso, sus dimensiones y lo que lleva cada uno. Sirve para preparar el despacho y para imprimir la **Lista de empaque** que viaja con la mercancía.

1. Crea el empaque de un **alistamiento confirmado**. Empieza con un solo paquete que lleva todo lo tomado. Cada alistamiento tiene un solo empaque: si lo pides otra vez, te muestra el que ya existe.
2. Arma los paquetes: para cada uno, su **número**, su **peso (kg)**, sus **dimensiones** (por ejemplo `40x30x30 cm`) y las líneas del alistamiento que lleva con su cantidad. Una línea puede repartirse entre varios paquetes.
3. El empaque muestra cuántos **paquetes** tiene y su **peso total**. En cada paquete, **Contenido** dice el código del producto, el lote o serial y la cantidad.
4. **Cierra** el empaque cuando esté listo. Cerrado, sus paquetes ya no cambian. Si hubo un error, **anúlalo** y crea otro.

El empaque no frena la entrega: la entrega del alistamiento se despacha esté el empaque abierto, cerrado o sin crear. Tampoco mueve existencias ni contabiliza.

### Lista de empaque

Desde el empaque, **Imprimir** genera el PDF **Lista de empaque**: número del empaque, alistamiento, pedido, cliente, bodega, paquetes y peso total, y una tabla con cada paquete (número, contenido, peso y dimensiones). La empresa puede cambiar el diseño en **Bodega › Parámetros › Plantillas**.

Lo que se ve si algo falla:

- «El alistamiento no está confirmado»: confirma primero el alistamiento.
- «Se empacó más de lo alistado»: la suma de una línea en todos los paquetes supera lo que se tomó.
- «El número de paquete está repetido» o «La línea no es de este alistamiento».
- «El empaque ya está cerrado» o «El empaque está anulado».

## Ubicación de lo recibido

Cuando entra mercancía a una bodega (una **entrada**), normalmente queda en la ubicación de recibo. La **ubicación de lo recibido** te dice a qué estante llevar cada línea y, al confirmarla, mueve las existencias allá.

### Reglas de ubicación

Una **regla de ubicación** dice a qué ubicación va lo que llega a una bodega: para una **categoría** de producto, o para todo lo demás si la dejas sin categoría. Cada regla tiene una **prioridad**: entre varias que aplican, gana la de número más bajo. No puede haber dos reglas iguales (misma bodega, categoría y ubicación), y la ubicación debe ser de esa bodega.

### Sugerencia y confirmación

1. Al guardar una entrada, Bodega la marca **Recibido por ubicar**: en la campana aparece el aviso con el número de la entrada, la bodega y cuántas líneas faltan.
2. Abre la sugerencia de esa entrada. Para cada línea propone la ubicación así, en este orden:
   - **Mismo lote**: si ese lote ya está guardado en otra ubicación de la bodega, lo propone allí, para que el lote quede junto.
   - **Regla de la categoría** del producto.
   - **Regla general** (sin categoría).
   - Sin regla, la línea queda sin propuesta y la eliges tú.
3. Revisa o cambia las ubicaciones y **confirma**. Inventario crea una **reubicación** (`RU-…`, ver [Inventario](inventario.md)) que saca las existencias de la ubicación de recibo y las pone en la de destino, con su mismo lote o serial. No cambia el costo ni genera comprobante. El aviso de la campana se cierra.

Solo se ubica lo que todavía está en la ubicación de recibo: si ya se movió algo, la sugerencia lo descuenta y confirmar más de lo que queda muestra «Se ubica más de lo que queda de la entrada en esa ubicación». Una ubicación de otra bodega muestra «La ubicación es de otra bodega: entre bodegas se mueve con un traslado».

Las entradas guardadas antes de activar el módulo Bodega no se marcan ni se sugieren.

## Preguntas frecuentes

- **«¿Por qué no se anula una reubicación?»** Porque no cambia cantidades ni costos. Si quedó mal, haz otra reubicación de vuelta.
- **«¿El empaque descuenta inventario?»** No. Las existencias salen al despachar la entrega.
- **«En la lista de empaque no se ve todo el contenido de un paquete»**: cada celda imprime una línea; si un paquete lleva muchos productos, repártelos en más paquetes o revisa el contenido completo en el registro del empaque.
