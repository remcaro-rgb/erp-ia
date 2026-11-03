---
title: Importar terceros, productos o categorías desde Excel o CSV
routes:
  - /import
  - /parties
  - /products
  - /categories
processes:
  - kernel.import.template
  - kernel.import.preview
  - kernel.import.run
  - kernel.import.list
---

# Importar terceros, productos o categorías desde Excel o CSV

Carga muchos registros de una vez con una plantilla. La importación valida cada fila con las mismas reglas del formulario (incluidas las de la DIAN), crea solo las filas válidas y te devuelve las rechazadas con el motivo en `errores.csv`.

## Quién puede importar

Necesitas el permiso **Importar datos** (`kernel.import.run`) y el permiso de crear registros de esa entidad (por ejemplo, crear terceros). La importación es una acción sensible: te pide el código de 6 dígitos de tu app de autenticación antes de empezar.

## Paso a paso

1. Abre **Terceros**, **Productos** o **Categorías** y pulsa **Importar** en la barra del listado. También puedes ir a **Importar datos** en el menú del módulo y elegir la entidad.
2. En **1 · Plantilla**, descarga la **Plantilla Excel** (trae listas desplegables con los valores permitidos) o la **Plantilla CSV**.
3. Llena una fila por registro sin cambiar los encabezados:
   - El NIT va sin dígito de verificación, sin puntos ni espacios: el sistema calcula el dígito.
   - Las columnas con varios valores (tipo de tercero, responsabilidades fiscales, otros impuestos) llevan los valores separados por `|`, por ejemplo `O-13|O-15`.
   - Sí / no se escribe `sí` o `no`.
   - Los valores con decimales aceptan `1.234.567,50` o `1234567.50`.
   - En productos, la **Categoría** y el **Proveedor** se escriben por su nombre, tal como aparecen en sus listados.
   - Un CSV puede ir separado por `;` o `,` y debe guardarse en UTF-8.
4. En **2 · Archivo**, arrastra el archivo o elígelo (máximo 25 MB y 50.000 filas).
5. Revisa la **Vista previa**: cada fila dice si es válida o lleva la marca **Fila con error**. Cada fila ocupa una sola línea; el motivo aparece al dejar el cursor sobre la marca o al pulsar **Ver** (con el teclado, Tab hasta **Ver** y Enter), que lo abre en una línea extra bajo la fila; **Ocultar** la cierra. Para ir directo a lo que debes corregir, activa **Solo filas con error (N)**: la lista muestra solo esas filas con el número que tienen en tu archivo. Si no hay filas con error, la casilla queda desactivada. Si falta una columna obligatoria, todas las filas se rechazarían: corrige el archivo antes de seguir.
6. Pulsa **Importar filas válidas** e ingresa el código de verificación. La importación sigue en segundo plano; puedes cerrar la ventana.

## Estado de lo importado

La importación sigue el mismo ciclo de vida que la pantalla (guía [Maestros y documentos](maestros-y-documentos.md)) y nunca aprueba ni contabiliza nada. Cada registro creado recibe su **ID** consecutivo, como si lo hubieras creado a mano:

- Un maestro (tercero, producto, categoría, cuenta…) queda **Grabado**. Si tu empresa exige aprobación para ese maestro (en **Parámetros**), queda **Pendiente de Aprobación** hasta que alguien con el permiso lo apruebe.
- Un documento (por ejemplo, un comprobante) queda en **Borrador** con sus líneas; lo grabas, envías a aprobación o contabilizas desde su registro, como cualquier otro.

## Documentos con líneas

Los documentos se importan solo desde Excel, con la **Plantilla Excel** del documento, que trae dos hojas:

- **Datos**: una fila por documento (su encabezado).
- **Líneas**: una fila por línea.

Ambas hojas empiezan por la columna `ref`, una referencia tuya (por ejemplo `1`, `2`, `F-001`) que solo vive en el archivo: cada línea va al documento que tiene su misma `ref`. Reglas de la unión:

- Si una línea tiene un error, se rechaza el documento completo (encabezado y todas sus líneas) y el motivo dice la fila de la hoja **Líneas**, por ejemplo «Líneas, fila 7: Cantidad: debe ser mayor que 0».
- Si dos filas de **Datos** tienen la misma `ref` (sin distinguir mayúsculas ni espacios), se rechazan todas ellas y sus líneas, porque el archivo no dice qué líneas van con cuál: «ref: repetido en el archivo (filas 2, 5)».
- Un encabezado sin ninguna línea se rechaza: «El documento no tiene líneas».
- Una línea cuya `ref` no está en **Datos** no se importa. No cuenta como documento rechazado: la vista previa la lista aparte («Líneas que no se importan») y `errores.csv` la incluye con su motivo.

La plantilla CSV no existe para documentos: un CSV tiene una sola hoja. En maestros y en documentos, la hoja de datos es la primera hoja visible del libro.

## Resultado

En **Importar datos › Historial** ves tus importaciones (el administrador de la empresa ve las de todos), cada una con su estado (en cola, en curso, terminada, fallida), cuántas filas se crearon y cuántas se rechazaron. Si hubo rechazos, el enlace **errores.csv** descarga las filas rechazadas con la columna `error` y sus datos originales: corrígelas y vuelve a importar solo ese archivo. En un documento con líneas, la columna `fila` dice la hoja y la fila (`Datos 3`, `Líneas 7`): cada encabezado rechazado va seguido de sus líneas, con las celdas de cada una a la derecha de las del encabezado, y al final las líneas sin encabezado.

Mientras una importación está en cola o en curso, el historial se actualiza solo cada 3 segundos y lo dice junto al título: **En vivo** con la hora de la última lectura, **En pausa** si la pestaña del navegador está oculta (vuelve a leer en cuanto regresas) o **Sin conexión** si no pudo leer; en ese caso pulsa **Reanudar**. Cada importación en curso muestra una barra con las filas procesadas («1.380 de 2.400 filas»). Cuando no queda nada en curso, el historial dice cuándo se leyó por última vez («Actualizado 10:42:07») y el botón **Actualizar** lo lee de nuevo. Las fechas se muestran en la hora de tu empresa.

- Un documento repetido dentro del archivo se rechaza en su segunda aparición; uno que ya existe en el sistema también se rechaza. Si el registro que ya existe es uno que tú no puedes ver (tiene acceso restringido), el motivo dice solo «Ya existe un registro con ese valor», sin mostrar nada de ese registro.
- Los registros con datos DIAN pendientes se crean, pero no se pueden facturar hasta completarlos.
- Si crear registros de esa entidad exige verificación en dos pasos en cada uno, la importación se detiene en la primera fila sin crear nada y el historial lo explica.
- Las celdas de `errores.csv` que empiezan por `=`, `+`, `-` o `@` llevan un apóstrofo delante para que Excel no las ejecute como fórmulas.
- Cada importación queda en la auditoría como «N creadas · M rechazadas», con el archivo original adjunto a la importación.
