---
title: "Productos: bienes y servicios"
routes:
  - /products
processes:
  - core.product.create
  - core.product.update
  - core.product.deactivate
  - core.product.consult
  - kernel.attachment.reorder
  - kernel.ai.image_suggest
---

# Productos: bienes y servicios

**Productos** es el catálogo de lo que vendes y compras, bienes y servicios. Cada producto lleva los datos que la factura electrónica de la DIAN pide por línea (código estándar, unidad de medida, impuestos), además de precio, costo e inventario.

Entra desde **Núcleo › Productos**, o con **⌘K** escribiendo «producto».

## El listado

Al comienzo muestra N.º, SKU, Descripción, Tipo de producto, Categoría, Código estándar, Unidad, Tarifa de IVA, Precio de lista, Costo estándar, Estado DIAN, Listo para facturar y Activo. Ordenar, filtrar, elegir columnas, guardar vistas y exportar funcionan como en todos los listados (guía **Listados**). **Importar** carga muchos productos desde Excel o CSV (guía **Importar datos**). Haz clic en una fila para abrir el producto en su propia pestaña.

## Crear un producto

1. Pulsa **Nuevo** (o **⌘K** y escribe «crear producto»).
2. En **Identificación**:
   - **Código interno** (SKU): obligatorio y único en la empresa. Si ya existe, el sistema responde «Ya existe un producto con el código …».
   - **Descripción en la factura**: el texto que sale en la línea de la factura.
   - **Tipo**: **Bien** o **Servicio**.
   - **Categoría**: elige una categoría activa; el producto hereda sus impuestos y su unidad de medida (ver abajo).
   - **Esquema de identificación** y **Código estándar**: por ejemplo GTIN (8, 12, 13 o 14 dígitos; se completa a 14) u otro esquema de la lista. Con el esquema «999» la factura lleva tu código interno y no hay código estándar que escribir.
   - **Marca** y **Modelo** (opcionales).
   - **Proveedor principal** (opcional): escribe parte del nombre, NIT o correo y elige de la lista, o pulsa la lupa para abrir el **filtro avanzado** de terceros. Solo ofrece terceros que son proveedores.
3. En **Unidad e impuestos**: **Unidad de medida**, **IVA**, **Impuesto nacional al consumo** y **Otros tributos de la línea**. El **Resumen fiscal de la línea** te explica el efecto: IVA excluido, exento (0 %) o la tarifa aplicada.
4. En **Precio y costo**: **Precio de lista** (en COP, sin IVA), **Costo estándar** (para calcular el **Margen**, que se muestra solo) y, si el producto es una **Muestra gratuita**, el **Tipo de precio de referencia** y el **Precio de referencia**, que es la base del IVA.
5. En **Inventario**: marca **Controla existencias** (**Sí, por bodega**) y, si quieres una alerta, el **Mínimo**. Un servicio no controla existencias.
6. Revisa el panel de estado DIAN y pulsa **Crear**.

Los importes se muestran como `$ 1.234.567,00`; mientras escribes ves los dígitos sin formato.

## Impuestos heredados de la categoría

Al elegir la categoría, el producto toma de ella el IVA, el impuesto al consumo y los otros tributos (y, si es nuevo, la unidad de medida). Junto al título **Unidad e impuestos** verás:

- «heredados de [categoría]» (en verde) si no los has cambiado, o
- «modificados respecto a [categoría]» (en ámbar), con el enlace **restablecer los de la categoría** para volver a los de ella.

Puedes cambiar los impuestos de un producto sin afectar a la categoría. Y al revés: cambiar los impuestos de una categoría no modifica los productos que ya existen (ver la guía **Categorías de productos**).

## Fotos

La pestaña **Fotos** de un producto guardado es un carrusel con miniaturas. La primera foto es la **principal**: la insignia sobre la imagen lo dice («principal · subida» o «principal · sugerida por IA»).

- **Agregar**: arrastra las imágenes a la zona punteada o pulsa **elígelas**. Se aceptan imágenes (JPG, PNG o WebP) de hasta 25 MB cada una. Las fotos también aparecen en la pestaña **Archivos**, con la etiqueta «Foto».
- **Ver**: usa las flechas ‹ › o las miniaturas.
- **Hacer principal**: con otra foto a la vista, pulsa **Hacer principal**; pasa al primer lugar y el orden se guarda (permiso **Reordenar archivos**, `kernel.attachment.reorder`). El orden se conserva al recargar y es el mismo en todo el sistema.
- **Quitar**: pulsa **Quitar** y confirma «¿Quitar esta foto?». La foto deja de estar disponible pero queda en la auditoría.
- Un producto que aún no se guardó muestra «Guarda el producto para agregar fotos».

### Sugerir foto con IA

Pulsa **✨ Sugerir foto con IA** (permiso **Sugerir foto con IA**, `kernel.ai.image_suggest`, y poder actualizar el producto). El sistema genera una imagen a partir de la descripción, la unidad y la categoría del producto y la agrega al final, con la etiqueta «Foto · IA» y la insignia «sugerida por IA». En esta primera versión la imagen es una ilustración sencilla con las iniciales del producto; la generación con un modelo de imágenes llegará en una fase posterior con el mismo botón. Cada vez que lo pulsas se agrega una sugerencia nueva. Al subir, quitar, ordenar o sugerir una foto, el registro se actualiza solo: el pie, la lista de archivos obligatorios y la pestaña **Archivos** reflejan el cambio. Quitar fotos requiere el permiso de quitar archivos; sin él no ves el botón **Quitar**.

Una foto sugerida **no cuenta como aprobada** hasta que la hagas principal: al pulsar **Hacer principal** en ella, la insignia pasa a «principal · subida» y deja de ser una sugerencia. Si no te sirve, quítala con **Quitar**. Cada sugerencia queda en la auditoría con el proceso `kernel.ai.image_suggest` y el usuario que la pidió.

## Estado DIAN y «Listo para facturar»

Igual que los terceros: los **errores** de formato impiden guardar; los **datos pendientes** permiten guardar con estado «Faltan N». Un producto está **Listo para facturar** cuando su estado DIAN es **Completo**, está **Activo** y tiene los archivos obligatorios que defina tu empresa (por defecto, la **Ficha técnica** en PDF es opcional). El pie del registro lo muestra («✓ Se puede usar en facturas» o «✕ No se puede usar en facturas») y se actualiza al subir o quitar archivos. Un producto que no está listo no se puede usar en una línea de factura; el panel **No se puede usar en facturas** dice por qué.

## Cambiar y desactivar

Abre el producto, modifica y pulsa **Guardar** (o **Descartar cambios**). Cambiar la categoría de un producto existente aplica los impuestos de la nueva y recalcula el estado DIAN. Un producto se **desactiva** con su proceso (permiso «Desactivar producto»; en esta versión el formulario no tiene un botón para hacerlo): deja de estar disponible para documentos nuevos, pero conserva su historial.

## Quién puede ver y cambiar qué

- Crear, actualizar, desactivar y consultar son permisos separados por rol. Sin el de actualizar, el formulario es de solo lectura.
- El **Costo estándar** puede estar enmascarado (••••••) u oculto para tu rol; en ese caso el margen no se calcula y el campo no se puede filtrar ni ordenar.
- Pestañas del registro: **Datos · Fotos · Datos adicionales · Archivos**.
