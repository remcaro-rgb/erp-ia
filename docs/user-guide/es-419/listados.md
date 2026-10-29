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
- Una **barra de botones**: **Nuevo** y **Importar** (si tu rol puede crear e importar), **Columnas**, **Guardar vista**, **Filtro avanzado**, los botones de exportar **PDF**, **Excel** y **CSV**, y **Limpiar filtros** cuando hay algo aplicado.
- La **tabla**: una fila por registro, con los encabezados que ordenan y, debajo de ellos, una fila de cajas para filtrar cada columna.
- El **pie**: las filas que estás viendo, las páginas y los totales.

Los importes se muestran como `$ 1.234.567,00`, alineados a la derecha. Un valor **enmascarado** para tu rol se ve como ••••••.

Haz clic en una fila (o enfócala y pulsa Enter) para abrir el registro en su propia pestaña.

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

Pulsa **Columnas**: aparece la lista de todas las columnas que tu rol puede ver, con una casilla cada una y el contador «8 de 15 columnas visibles». Marca o desmarca las que quieras; siempre queda al menos una. **Restablecer columnas** vuelve a las del comienzo. Las columnas que tu rol no puede ver no se ofrecen. Los **datos adicionales** de tu empresa están en esta lista (apagados al comienzo).

## Páginas

El pie muestra «Filas 1–10 de 124», los botones ‹ 1 2 3 … › y un menú de **10, 25, 50 o 100 por página** (empieza en 10). Cambiar el tamaño te devuelve a la página 1.

## Totales y selección

- Si el listado tiene columnas de dinero, el pie muestra la **suma de todo lo filtrado** («Suma saldo filtrado: $ 1.500.000,00»), de todas las páginas.
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

Las condiciones aplicadas se ven como fichas sobre la tabla, cada una con su ✕ para quitarla, y el botón pasa a decir «Filtro avanzado (2)». Los campos enmascarados aparecen en la lista marcados «(enmascarado)» y no se pueden elegir; los datos adicionales aparecen marcados «(adicional)».

## La lupa de los campos de registro

Algunos campos de un formulario apuntan a otro registro; por ejemplo, el **Proveedor principal** de un producto. Esos campos tienen una lupa:

- **Escribe** parte del nombre, NIT, código o correo: la lista se llena mientras escribes con las coincidencias, mostrando su estado DIAN. Muévete con ↑ ↓ y elige con **Enter** o un clic.
- Pulsa la **lupa** para abrir el mismo **Filtro avanzado**, esta vez para escoger: al hacer clic en una fila queda seleccionada en el campo, sin salir del formulario. El campo de proveedor solo ofrece terceros que son proveedores.
- Para quitar la selección, usa la ✕ del campo.

## Guardar vistas

Una **vista** guarda cómo dejaste el listado: los filtros por columna, el filtro avanzado con sus Y / O, el orden, las columnas visibles y el tamaño de página.

1. Deja el listado como lo quieres.
2. Pulsa **Guardar vista**. Se abre el panel **Vistas**.
3. Escribe el **Nombre de la vista** (hasta 80 caracteres). Marca **Usarla como vista por defecto** si quieres que el listado se abra así siempre.
4. Pulsa **Guardar**. Verás «Vista guardada: [nombre]».

Para usar una vista, abre el panel **Vistas** y pulsa su nombre. La vista por defecto lleva una estrella ★. Con la ✕ de cada fila la borras. Si guardas otra vista con el mismo nombre, reemplaza la anterior; solo una vista puede ser la predeterminada por listado.

Las vistas son **tuyas**: son por usuario y por empresa, y nadie más las ve ni las puede cambiar. Guardar, listar y borrar vistas son permisos que tiene cada rol; si tu rol no los tiene, el botón **Guardar vista** no sirve.

## Exportar e importar

- **PDF**, **Excel** y **CSV** exportan exactamente lo que ves, de todas las páginas (guía **Exportar un listado**).
- **Importar** carga registros desde una plantilla de Excel o CSV (guía **Importar datos**).

## Si algo no funciona

- «Un campo oculto o enmascarado para tu rol no se puede usar para filtrar ni ordenar.»: quita ese filtro u orden.
- «Tu rol no puede consultar este listado» o «Tu empresa no tiene habilitado este listado»: pide acceso al administrador de tu empresa.
- «Sin resultados» en un listado sin filtros: no hay registros todavía. «Sin resultados con estos filtros»: ningún registro cumple lo que aplicaste; usa **Limpiar filtros**.
