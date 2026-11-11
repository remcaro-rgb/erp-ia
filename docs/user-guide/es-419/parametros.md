---
title: Parámetros de maestros y documentos
routes:
  - /core/parametros/tipos
  - /core/parametros/destinatarios
  - /core/parametros/plantillas
  - /accounting/parametros/tipos
  - /accounting/parametros/destinatarios
  - /accounting/parametros/plantillas
  - /inventory/parametros/tipos
  - /inventory/parametros/destinatarios
  - /inventory/parametros/plantillas
  - /costing/parametros/tipos
  - /costing/parametros/destinatarios
  - /costing/parametros/plantillas
  - /crm/parametros/tipos
  - /crm/parametros/destinatarios
  - /crm/parametros/plantillas
  - /sales/parametros/tipos
  - /sales/parametros/destinatarios
  - /sales/parametros/plantillas
  - /invoicing/parametros/tipos
  - /invoicing/parametros/destinatarios
  - /invoicing/parametros/plantillas
  - /payments/parametros/tipos
  - /payments/parametros/destinatarios
  - /payments/parametros/plantillas
  - /warehouse/parametros/tipos
  - /warehouse/parametros/destinatarios
  - /warehouse/parametros/plantillas
processes:
  - kernel.entity_type_settings.update
  - kernel.state_recipients.update
  - kernel.doc_template.save
  - kernel.doc_template.set_default
  - kernel.doc_template.print
  - kernel.admin.company.update
---

# Parámetros de maestros y documentos

Cada módulo tiene en su barra superior la sección **Parámetros**. Además de los ajustes propios del módulo, ahí están tres pantallas para sus **maestros** (terceros, productos, cuentas…) y **documentos** (comprobantes…):

- **Configuración de tipos**: si los registros nuevos requieren aprobación y si un documento contabiliza.
- **Destinatarios por estado**: a quién se le envía el PDF de un registro cuando llega a un estado.
- **Plantillas PDF**: cómo se ve el PDF de un registro o de un listado.

Solo las ve y las cambia el **administrador** de la empresa. Para cualquier otra persona no aparecen en el menú, y si abre su dirección la pantalla dice «No tienes permiso.». Cada cambio pide tu **código de 6 dígitos** y queda en la auditoría.

## Configuración de tipos

La tabla lista los maestros y documentos del módulo, con su **Tipo** (Maestro o Documento).

1. Activa o desactiva **Requiere aprobación** en la fila que quieras. En un documento también puedes cambiar **Contabiliza**. Los maestros no contabilizan.
2. Pulsa **Guardar** y escribe tu código (uno por cada fila que cambiaste).

Los valores **se copian en cada registro al crearlo**: cambiarlos no altera los registros que ya existen. Si activas la aprobación para Terceros, un tercero nuevo muestra **Guardar y enviar a aprobación** y queda **Pendiente de Aprobación** hasta que alguien lo apruebe.

Algunas entidades definen sus valores ellas mismas y muestran una nota en lugar del interruptor. Por ejemplo, el comprobante contable toma la aprobación de su **fuente** («Requiere aprobación en comprobantes manuales») y siempre contabiliza. El **alistamiento** de Bodega tampoco tiene interruptores: nunca requiere aprobación y nunca contabiliza ni mueve existencias (el inventario sale con la entrega).

## Destinatarios por estado

1. Elige la **Entidad**.
2. En la fila del estado (por ejemplo **Aprobado**), escribe un correo y pulsa **Enter**. Repite para agregar más (máximo 50 por estado). Un correo mal escrito se rechaza con su motivo. Para quitar uno, pulsa la **✕** junto a él.
3. Pulsa **Guardar** y escribe tu código.

Cuando un registro entra en ese estado, el sistema envía su PDF, con la plantilla predeterminada, a todos los correos de la lista **en copia oculta**: ningún destinatario ve las direcciones de los demás. Sin lista no se envía nada. El PDF se genera con los permisos de quien hizo el cambio: un campo que esa persona no puede ver sale vacío. Cada envío queda registrado.

Un maestro no tiene los estados Contabilizado ni Anulado.

## Plantillas PDF

Arriba está la lista de plantillas del módulo con su entidad, su alcance, su versión y si es la **predeterminada**. Una entidad sin plantilla predeterminada imprime con la plantilla del sistema.

### Crear o cambiar una plantilla

1. Pulsa **Nueva plantilla**, o el nombre de una plantilla de la lista para abrirla.
2. Escribe el **Nombre** y elige la **Entidad** y el **Alcance**: **Un registro** (el PDF de Imprimir en el registro y el de los correos) o **Listado (reporte)** (el PDF de Imprimir en un listado). Una plantilla nueva empieza con el diseño del sistema. La entidad y el alcance no cambian después de guardar.
3. Edita los **Bloques**. Cada bloque tiene su tipo, su posición (**X**, **Y**), su **Ancho**, su **Alto** y, si tiene texto, su **Tamaño**, **Negrita** y **Alineación**. Las medidas están en puntos (una hoja A4 mide 595 × 842).
   - **Texto fijo**: un texto que escribes.
   - **Variable**: un dato de la empresa o de la impresión, como `empresa.nombre`, `empresa.nit`, `usuario.nombre` o `fecha_impresion`. En un listado también `registros` y los totales `total.<campo>`.
   - **Campo**: un dato del registro (solo en plantillas de un registro).
   - **Tabla de líneas**: las líneas del documento, o las filas del listado; marca las columnas (sin ninguna marcada se imprimen todas).
   - **Imagen**: el logo de la empresa.
   - **N.º de página**: «Página 1 de 3», o el formato que escribas con `{n}` y `{total}`.
4. Para agregar un bloque elige el **Tipo de bloque** y pulsa **Agregar bloque**, o pulsa una variable o un campo en **Variables**. Con ▲ y ▼ cambias el orden y con ✕ quitas el bloque. Pulsa el encabezado de un bloque para abrirlo o cerrarlo.
5. La **Vista previa** muestra la hoja mientras editas. Pulsa un bloque en la vista previa para editarlo.
6. Pulsa **Guardar** y escribe tu código. Cada vez que guardas se crea una **versión** nueva.

Si otra persona guardó la misma plantilla mientras la editabas, el sistema no guarda tus cambios y dice «Otra persona guardó esta plantilla». Pulsa **Recargar** para ver su versión y vuelve a hacer tus cambios.

**Ver PDF** imprime la plantilla guardada con el registro más reciente de la entidad (o con las primeras filas, si es de listado).

### Predeterminada

Con la plantilla abierta y guardada, activa **Predeterminada para…** y escribe tu código. Desde ese momento Imprimir y los correos usan esa plantilla. Al desactivarla vuelve la plantilla del sistema.

### Fondo y logo

- **Fondo (membrete)**: sube un PDF con **Subir PDF de fondo** y elígelo en **PDF de fondo**. Su primera página va debajo de la primera hoja y la segunda (si existe) debajo de las siguientes. Guarda la plantilla para aplicarlo.
- **Logo de la empresa**: sube una imagen PNG o JPEG con **Subir logo**. El logo es de la empresa: lo imprimen todas las plantillas que tienen un bloque **Imagen**. **Quitar logo** lo deja sin logo.

Primero guarda la plantilla: los archivos se adjuntan a una plantilla guardada. La dirección, la ciudad y el teléfono de la empresa se cambian en **Administración › Empresa**.

Un campo que quien imprime no puede ver se imprime vacío. El dinero se imprime como $ 1.234.567,00.

## Imprimir un listado

En el listado de un maestro o un documento, el botón **Imprimir** genera el PDF de lo que ves: los filtros, el orden y las columnas visibles, todas las páginas, con la plantilla de listado predeterminada. El PDF se descarga. Un listado de más de 2.000 filas no se imprime: fíltralo o usa **Exportar › PDF**.
