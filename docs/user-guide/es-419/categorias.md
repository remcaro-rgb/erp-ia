---
title: Categorías de productos
routes:
  - /categories
processes:
  - core.category.create
  - core.category.update
  - core.category.consult
  - core.product_category.save
  - core.product_category.submit
  - core.product_category.approve
  - core.product_category.reject
  - core.product_category.delete
---

# Categorías de productos

Una **categoría** agrupa productos que comparten impuestos. Defines una vez el IVA, el impuesto al consumo, los otros tributos y la unidad de medida por defecto, y cada producto nuevo que asignes a esa categoría los hereda.

Entra desde **Núcleo › Maestros › Categorías**, o con **⌘K** escribiendo «categoría».

## El listado

Muestra ID, Nombre, Tarifa de IVA, Tarifa de INC, Otros impuestos, Unidad de medida por defecto, Cuenta de ingresos y Activa (**Activa** o **Inactiva**). Ordenar, filtrar, guardar vistas, exportar e importar funcionan como en los demás listados (guías **Listados**, **Exportar un listado** e **Importar datos**).

## Crear una categoría

1. Pulsa **Nuevo** (o **⌘K** y escribe «crear categoría»).
2. En **Categoría** escribe el **Nombre** (hasta 100 caracteres). El campo **Activa** viene con «Activa»: déjalo así para poder asignar la categoría a productos.
3. En **Impuestos por defecto** elige:
   - **IVA** (obligatorio),
   - **INC** (impuesto nacional al consumo; «Ninguno» si no aplica),
   - **Unidad de medida por defecto**,
   - **Otros tributos** que apliquen,
   - **Cuenta de ingreso**: de 4 a 8 dígitos del PUC (para la contabilidad que llegará en una fase posterior).
4. Cuando el cuadro inferior dice «Lista para usar», pulsa **Crear**. También puedes guardar con el teclado desde cualquier campo: **Ctrl+S** o **Ctrl+Enter** (en Mac, **⌘S** o **⌘Enter**); **Enter** no guarda: pasa al campo siguiente (**Mayús+Enter** vuelve al anterior; guía **Moverse por el sistema**, «Llenar un formulario con el teclado»). Si el sistema rechaza el guardado, el cursor salta al primer campo con error, o al cuadro que explica el motivo. Si falta el nombre dice «Falta: nombre».

Dos categorías no pueden llamarse igual en la misma empresa, sin importar mayúsculas y minúsculas («Ya existe una categoría llamada …»).

## Qué pasa con los productos

- Los productos **nuevos** que asignes a la categoría heredan sus impuestos (y su unidad de medida).
- **Cambiar los impuestos de una categoría no modifica los productos que ya existen.** La nueva configuración se aplica a los productos nuevos y a los que, al editarlos, pulsen «restablecer los de la categoría».
- Al abrir una categoría existente, un recuadro te dice cuántos productos tiene.
- Una categoría **Inactiva** no se puede asignar a productos; los que ya la tenían la conservan.

## Permisos

Crear, actualizar y consultar categorías son permisos distintos por rol; sin el de actualizar, el formulario es de solo lectura. El formulario no tiene un botón para borrar una categoría: para dejar de usarla, cambia **Activa** a «Inactiva». Pestañas del registro: **Datos · Datos adicionales · Archivos**. **Duplicar** (o **Ctrl+D**) crea una categoría nueva con los mismos impuestos y el nombre vacío (guía **Moverse por el sistema**, «Duplicar un registro»).

## Estados, aprobación, impresión y acceso

Las categorías son un **maestro** (guía [Maestros y documentos](maestros-y-documentos.md)):

- Cada una categoría tiene un **ID** consecutivo que nunca se repite; búscalo en la columna **ID** del listado o escribiéndolo en **⌘K**.
- La barra de acciones del registro tiene **Nuevo**, **Duplicar**, **Imprimir** (el PDF del registro, guía [Plantillas PDF e Imprimir](plantillas-pdf.md)) y **Guardar**. Si el administrador activó **Requiere aprobación** en **Parámetros › Configuración de tipos**, aparece también **Guardar y enviar a aprobación**, y quien tiene el permiso ve **Aprobar** y **No aprobar**.
- Un maestro se puede usar en documentos cuando está **Activo** y aprobado (o grabado, si no requiere aprobación). Para dejar de usarlo, cambia **Activo** a «No»; **Eliminar** solo funciona si nada lo usa.
- El pie dice **Creado en … por …** y **Modificado en … por …**. Los maestros no tienen **Notificar** ni **Versiones**: sus cambios quedan en la auditoría.
- Un administrador puede restringir una categoría concreto a ciertos roles o usuarios en la pestaña **Acceso** (guía [Acceso por registro](acceso-por-registro.md)).
