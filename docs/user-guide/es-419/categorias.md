---
title: Categorías de productos
routes:
  - /categories
processes:
  - core.category.create
  - core.category.update
  - core.category.consult
---

# Categorías de productos

Una **categoría** agrupa productos que comparten impuestos. Defines una vez el IVA, el impuesto al consumo, los otros tributos y la unidad de medida por defecto, y cada producto nuevo que asignes a esa categoría los hereda.

Entra desde **Núcleo › Categorías**, o con **⌘K** escribiendo «categoría».

## El listado

Muestra N.º, Nombre, Tarifa de IVA, Tarifa de INC, Otros impuestos, Unidad de medida por defecto, Cuenta de ingresos y Estado (**Activa** o **Inactiva**). Ordenar, filtrar, guardar vistas, exportar e importar funcionan como en los demás listados (guías **Listados**, **Exportar un listado** e **Importar datos**).

## Crear una categoría

1. Pulsa **Nuevo** (o **⌘K** y escribe «crear categoría»).
2. En **Categoría** escribe el **Nombre** (hasta 100 caracteres) y deja el **Estado** en **Activa**.
3. En **Impuestos por defecto** elige:
   - **IVA** (obligatorio),
   - **INC** (impuesto nacional al consumo; «Ninguno» si no aplica),
   - **Unidad de medida por defecto**,
   - **Otros tributos** que apliquen,
   - **Cuenta de ingreso**: de 4 a 8 dígitos del PUC (para la contabilidad que llegará en una fase posterior).
4. Cuando el cuadro inferior dice «Lista para usar», pulsa **Crear**. También puedes guardar con el teclado desde cualquier campo: **Ctrl+S** o **Ctrl+Enter** (en Mac, **⌘S** o **⌘Enter**); **Enter** solo no guarda. Si el sistema rechaza el guardado, el cursor salta al primer campo con error, o al cuadro que explica el motivo. Si falta el nombre dice «Falta: nombre».

Dos categorías no pueden llamarse igual en la misma empresa, sin importar mayúsculas y minúsculas («Ya existe una categoría llamada …»).

## Qué pasa con los productos

- Los productos **nuevos** que asignes a la categoría heredan sus impuestos (y su unidad de medida).
- **Cambiar los impuestos de una categoría no modifica los productos que ya existen.** La nueva configuración se aplica a los productos nuevos y a los que, al editarlos, pulsen «restablecer los de la categoría».
- Al abrir una categoría existente, un recuadro te dice cuántos productos tiene.
- Una categoría **Inactiva** no se puede asignar a productos; los que ya la tenían la conservan.

## Permisos

Crear, actualizar y consultar categorías son permisos distintos por rol; sin el de actualizar, el formulario es de solo lectura. Las categorías no se borran: se marcan **Inactiva**. Pestañas del registro: **Datos · Datos adicionales · Archivos**.
