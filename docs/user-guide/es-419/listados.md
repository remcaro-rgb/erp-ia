---
title: "Listados: ordenar, filtrar y guardar vistas"
routes:
  - /parties
  - /products
  - /categories
  - /support
processes:
  - kernel.saved_view.save
  - kernel.saved_view.list
  - kernel.saved_view.delete
---

# Listados: ordenar, filtrar y guardar vistas

Terceros, Productos, Categorías y Soporte son **listados** que funcionan igual. Esta guía explica todo lo que puedes hacer en ellos.

## Qué ves

- El **título** del listado y, a su lado, cuántos registros hay con los filtros actuales («124 registros»). Mientras llega la primera página dice «Cargando…» y la tabla muestra filas grises de espera. Si tu rol tiene columnas ocultas o enmascaradas, también lo dice («2 ocultas, 1 enmascarada»).
- Una **barra de botones**: **Nuevo** y **Importar** (si tu rol puede crear e importar), **Columnas**, **Guardar vista**, **Filtro avanzado**, los botones de exportar **PDF**, **Excel** y **CSV**, y **Limpiar filtros**, que solo se activa cuando hay algo aplicado. Junto a los botones, un espacio fijo dice qué está haciendo el listado («Actualizando…», «Generando CSV…», «Descarga lista: …»); el aviso de descarga lista se borra solo a los 8 segundos. Nada de esto mueve la tabla.
- La **tabla**: una fila por registro, con los encabezados que ordenan y, debajo de ellos, una fila de cajas para filtrar cada columna. La primera columna es la que **identifica** el registro (la razón social en Terceros, la descripción en Productos, el nombre en Categorías): junto con la columna de casillas queda **fija a la izquierda** cuando desplazas la tabla hacia los lados, con una sombra en su borde, para que siempre sepas de qué fila se trata. Si hay columnas de dinero, la fila **Suma** queda fija abajo (ver «Totales y selección»).
- El **pie**: las filas que estás viendo, las páginas y lo que tienes seleccionado.

Los importes se muestran como `$ 1.234.567,00`, alineados a la derecha. Un valor **enmascarado** para tu rol se ve como ••••••.

Haz clic en una fila (o enfócala y pulsa Enter) para abrir el registro en su propia pestaña.

## Enlaces a registros

Cuando una columna muestra **otro registro** (el **Proveedor** o la **Categoría** de un producto, el **Solicitante** de un ticket), ves su nombre subrayado como enlace: un clic abre la página de ese registro en la misma pestaña del navegador, sin abrir la fila; con **Ctrl** (o **⌘** en Mac) se abre en una pestaña nueva. Un usuario se abre en su página de **Administración › Usuarios**.

- Si tu rol no puede consultar ese tipo de registro, la celda muestra los primeros 8 caracteres de su identificador, sin enlace.
- Si puedes consultarlo pero no ves su nombre (tu rol no ve ese tercero, o tiene enmascarado el dato que lo nombra), el enlace muestra esos 8 caracteres.
- Las columnas de otro registro se ordenan y filtran como las demás.

En los formularios pasa lo mismo: junto a la lupa de un campo que apunta a otro registro (el **Proveedor principal** de un producto) aparece una flecha ↗ «Abrir …» que abre el registro elegido.

## Usar el listado con el teclado

Las filas son **una sola parada** de **Tab**: desde la fila de filtros, **Tab** te lleva a la fila activa y el siguiente **Tab** sale de la tabla hacia el pie. Dentro de las filas:

- **↑ ↓** se mueven de fila en fila; **↑** en la primera fila vuelve a los filtros.
- **Inicio** y **Fin** van a la primera y a la última fila de la página; **Re Pág** y **Av Pág** cambian de página.
- **Espacio** selecciona o quita la selección de la fila (como su casilla).
- **Enter** abre el registro.
- **/** (desde cualquier parte del listado que no sea una caja de texto) pone el cursor en el primer filtro.

El pie lo recuerda: «↑↓ moverse · Espacio seleccionar · Enter abrir · / filtrar».

## Ordenar

- Pulsa el encabezado de una columna: primero ordena de menor a mayor (▲), al pulsar de nuevo de mayor a menor (▼) y a la tercera vez quita el orden.
- Para ordenar por varias columnas, mantén **Shift** al pulsar los encabezados siguientes; un número pequeño indica la prioridad de cada una.
- Una columna enmascarada u oculta para tu rol no se puede ordenar.

## Filtrar por columna

La fila de cajas bajo los encabezados filtra mientras escribes, según el tipo de columna:

- **Texto**: escribe una parte de lo que buscas («contiene…»).
- **Columnas con códigos** (municipio, departamento, país, régimen, tipo de documento, tarifa de IVA, unidad…): filtra por lo que ves en la celda, sin importar tildes ni mayúsculas: «medell» encuentra Medellín. También sirve el código («05001»).
- **Números e importes**: escribe una comparación, como `>= 1000`, `< 500` o `= 3`, o un rango como `1000..5000`. Un número solo significa «mayor o igual».
- **Fechas**: elige **Desde** y **Hasta**.
- **Listas y Sí / No** (tipo de tercero, estado, activo…): elige un valor del menú, o **Todos**.

Las cajas con un filtro aplicado se tiñen. Una columna enmascarada muestra su caja desactivada. **Limpiar filtros** quita los filtros, el filtro avanzado y el orden (las columnas visibles y el tamaño de página se mantienen).

## Elegir las columnas

Pulsa **Columnas**: aparece la lista de todas las columnas que tu rol puede ver, **en el orden del listado**, con una casilla cada una y el contador «8 de 15 columnas visibles». Marca o desmarca las que quieras; siempre queda al menos una. Una columna que apagas **guarda su lugar** mientras tengas el listado abierto: al volver a marcarla aparece donde estaba. Una vista guardada recuerda las columnas visibles en su orden; al aplicarla, cada columna apagada queda justo después de la columna que la antecede en el orden original del listado, esté donde esté esa columna en la vista. La columna que identifica el registro dice «fija»: no tiene flechas y nada se pone delante de ella. Para cambiar el orden mira «Mover columnas». **Restablecer columnas** vuelve a las columnas y al orden del comienzo. Las columnas que tu rol no puede ver no se ofrecen. Los **datos adicionales** de tu empresa están en esta lista (apagados al comienzo).

## Mover columnas

Puedes poner las columnas en el orden que te sirva:

- **Con el ratón**: arrastra el encabezado de una columna y suéltalo sobre otro. Una barra azul marca dónde va a quedar (a la izquierda o a la derecha del encabezado que tienes debajo).
- **Con el teclado**: pon el cursor en un encabezado (con **Tab**) y pulsa **Alt+←** o **Alt+→** para moverlo un puesto. El cursor se queda en ese encabezado, así puedes seguir moviéndolo.
- **Desde Columnas**: las flechas **↑** y **↓** de cada fila la suben o la bajan un puesto.

Junto a los botones el listado avisa el resultado, por ejemplo «Columna Municipio movida a la posición 3». La columna que identifica el registro siempre queda primera: no se mueve y si sueltas otra columna sobre ella, esa queda justo después.

El orden forma parte de la vista: las exportaciones salen con las columnas en ese mismo orden y, si guardas una vista, el orden se guarda con ella.

## Páginas

El pie muestra «Filas 1–10 de 124», los botones ‹ 1 2 3 … › y un menú de **10, 25, 50 o 100 por página** (empieza en 10). Cambiar el tamaño te devuelve a la página 1.

## Totales y selección

- Si el listado tiene columnas de dinero, la fila **Suma**, fija abajo mientras desplazas la tabla, muestra bajo cada una de ellas la **suma de todo lo filtrado**, de todas las páginas (no solo de la que ves). Una columna enmascarada para tu rol no suma.
- Con las casillas de la izquierda seleccionas filas (o todas las de la página) y el pie suma también lo **seleccionado** («3 seleccionadas»). Al cambiar de página la selección se limpia.

## Filtro avanzado

Cuando los filtros por columna no alcanzan, pulsa **Filtro avanzado**. Se abre una ventana para armar condiciones sobre **cualquier campo** del registro, también los que no están en las columnas visibles:

1. Cada condición tiene **Campo · Regla · Valor**. La primera empieza con «Donde».
2. Las reglas dependen del tipo del campo:
   - Texto: contiene, no contiene, empieza con, termina con, igual a, distinto de, está vacío, no está vacío. En los campos con códigos (municipio, país, régimen…) la regla se compara con el nombre que ves y con el código: «Municipio contiene Bogotá» O «Municipio contiene Medellín» trae los terceros de las dos ciudades.
   - Números e importes: =, ≠, mayor que, mayor o igual, menor que, menor o igual, entre (con un segundo valor «Hasta»), está vacío, no está vacío.
   - Listas: igual a, distinto de, es uno de (puedes elegir varios).
   - Fechas: el día, después de, antes de, entre.
3. **+ Condición** agrega otra. Desde la segunda eliges cómo se une con la anterior: **Y** u **O**.
4. **Y se evalúa antes que O**: «A y B o C» significa «(A y B) o C». Una línea separa cada grupo que empieza con **O**.
5. Debajo, la lista de **Resultados** se actualiza sola mientras editas: ves cuántos registros cumplen y los primeros 50 («se muestran 50; afina las condiciones»).
6. Pulsa **Aplicar** para filtrar el listado con esas condiciones. **Limpiar** vacía el formulario y **Cancelar** cierra sin cambiar nada. Si haces clic en una fila de los resultados, se aplican las condiciones y se abre ese registro.
7. Con el teclado: **Enter** en una caja de valor aplica las condiciones; **Alt+↓** lleva el cursor a los resultados, donde **↑ ↓**, **Inicio** y **Fin** se mueven y **Enter** (o **Espacio**) elige la fila. La lista lo recuerda: «Enter aplica · Alt+↓ va a los resultados · Enter elige».

Las condiciones aplicadas se ven como fichas sobre la tabla, cada una con su ✕ para quitarla, y el botón pasa a decir «Filtro avanzado (2)». Los campos enmascarados aparecen en la lista marcados «(enmascarado)» y no se pueden elegir; los datos adicionales aparecen marcados «(adicional)».

## La lupa de los campos de registro

Algunos campos de un formulario apuntan a otro registro; por ejemplo, el **Proveedor principal** de un producto. Esos campos tienen una lupa:

- **Escribe** parte del nombre, NIT, código o correo: la lista se llena mientras escribes con las coincidencias, mostrando su estado DIAN. Muévete con ↑ ↓ y elige con **Enter** o un clic.
- Pulsa la **lupa** para abrir el mismo **Filtro avanzado**, esta vez para escoger: al hacer clic en una fila queda seleccionada en el campo, sin salir del formulario. El campo de proveedor solo ofrece terceros que son proveedores.
- Para quitar la selección, usa la ✕ del campo.

## Guardar vistas

Una **vista** guarda cómo dejaste el listado: los filtros por columna, el filtro avanzado con sus Y / O, el orden de las filas, las columnas visibles **en su orden** y el tamaño de página.

1. Deja el listado como lo quieres.
2. Pulsa **Guardar vista**. Se abre el panel **Vistas**.
3. Escribe el **Nombre de la vista** (hasta 80 caracteres). Marca **Usarla como vista por defecto** si quieres que el listado se abra así siempre.
4. Pulsa **Guardar**. Verás «Vista guardada: [nombre]».

Para usar una vista, abre el panel **Vistas** y pulsa su nombre. La vista por defecto lleva una estrella ★. Con la ✕ de cada fila la borras: antes pregunta en el mismo lugar «¿Eliminar [nombre]?»; confirma con ese botón (o **Enter**), y si no haces nada se vuelve a la ✕ a los 4 segundos. Al abrir el panel (igual que el de **Columnas**) el cursor queda en su primer control; **Esc** lo cierra y devuelve el cursor al botón, y si pasas con **Tab** a otro control el panel se cierra solo. Si guardas otra vista con el mismo nombre, reemplaza la anterior; solo una vista puede ser la predeterminada por listado.

Las vistas son **tuyas**: son por usuario y por empresa, y nadie más las ve ni las puede cambiar. Guardar, listar y borrar vistas son permisos que tiene cada rol; si tu rol no los tiene, el botón **Guardar vista** no sirve.

## Exportar e importar

- **PDF**, **Excel** y **CSV** exportan exactamente lo que ves, de todas las páginas (guía **Exportar un listado**).
- **Importar** carga registros desde una plantilla de Excel o CSV (guía **Importar datos**).

## Si algo no funciona

- «Un campo oculto o enmascarado para tu rol no se puede usar para filtrar ni ordenar.»: quita ese filtro u orden.
- «Tu rol no puede consultar este listado» o «Tu empresa no tiene habilitado este listado»: pide acceso al administrador de tu empresa.
- «Sin resultados» en un listado sin filtros: no hay registros todavía. «Sin resultados con estos filtros»: ningún registro cumple lo que aplicaste; usa **Limpiar filtros**.
