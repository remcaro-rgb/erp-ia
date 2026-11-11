---
title: Exportar un listado a PDF, Excel o CSV
routes:
  - /parties
  - /products
  - /categories
  - /support
processes:
  - kernel.export.run
---

# Exportar un listado a PDF, Excel o CSV

Cada listado (Terceros, Productos, Categorías…) tiene tres botones para llevarse lo que ves: **PDF** (rojo), **Excel** (verde) y **CSV** (gris). El archivo trae exactamente lo que muestra la pantalla: los mismos filtros, el mismo orden y las mismas columnas, **de todas las páginas**, no solo la que estás viendo.

## Quién puede exportar

Necesitas el permiso **Exportar grids y reportes** (`kernel.export.run`) y poder consultar la entidad que exportas (por ejemplo, ver terceros). Si tu empresa no tiene habilitado el módulo, el listado ni aparece.

## Paso a paso

1. Abre el listado y deja la pantalla como la quieres en el papel: filtra, ordena y elige las columnas (botón **Columnas**).
2. Pulsa **PDF**, **Excel** o **CSV**. Junto a los botones aparece «Generando…».
3. El navegador descarga el archivo, por ejemplo `terceros-2026-10-28.xlsx`. Mientras se genera uno, los botones esperan: se exporta de a uno.

## Qué trae cada formato

- **Excel**: una hoja con el nombre del listado. Las fechas son fechas, los montos son números con formato `#,##0.00` (puedes sumarlos), el encabezado queda inmovilizado arriba y cada columna tiene filtro.
- **CSV**: texto en UTF-8 (con BOM, para que Excel respete las tildes), separado por `;` en español latinoamericano, con las fechas en formato ISO (`2026-10-28`) y los montos sin símbolo (`1234567,50`). Una celda de texto que empieza por `=`, `+`, `-` o `@` lleva un apóstrofo delante para que Excel no la ejecute como fórmula.
- **PDF**: hoja A4 horizontal con el encabezado repetido en cada página, número de página, los montos como `$ 1.234.567,00` y, si hay columnas de dinero, una fila de **Total** al final.

## Lo que tu rol no ve, no sale

- Una columna **oculta** para tu rol no está en el archivo.
- Una columna **enmascarada** sale como `••••••` en todas las filas, igual que en la pantalla.
- Las columnas de **Datos adicionales** salen solo si tu rol puede verlas.
- Un registro con **acceso restringido** que tú no puedes ver no sale en el archivo, igual que no sale en el listado.

La columna **Estado** de un maestro o documento sale con su nombre (Borrador, Grabado, Pendiente de Aprobación, No Aprobado, Aprobado, Contabilizado, Anulado), no con su código. La columna **ID** sale con el número consecutivo de cada registro (guía [Maestros y documentos](maestros-y-documentos.md)).

## Exportar o Imprimir

Los listados de maestros y documentos tienen además **Imprimir**, que genera un PDF con la **plantilla de listado** de la empresa (membrete, logo, totales), hasta 2.000 filas. **Exportar › PDF** es el PDF de datos, sin plantilla, hasta 10.000 filas. Para imprimir un solo registro, ábrelo y pulsa **Imprimir** en su barra de acciones (guía [Plantillas PDF e Imprimir](plantillas-pdf.md)).

## Listados grandes

Hasta 9.999 filas el archivo se descarga al instante. Desde **10.000 filas** se genera en segundo plano: verás «Son muchas filas: se genera en segundo plano…» y la descarga empieza sola cuando termina (el enlace dura 10 minutos). Un **PDF** se arma en memoria, así que pasa a segundo plano desde **2.001 filas** y admite hasta **10.000**: para listados más grandes usa Excel o CSV (la pantalla lo avisa). Si pasan 10 minutos sin que termine, la pantalla deja de esperar y te lo dice; el archivo sigue generándose. Puedes seguir trabajando, también en otras pestañas de Goliatt: la exportación sigue, el archivo se descarga solo y, si no estás en ese listado, un aviso abajo dice «Terceros · Descarga lista: …» (o por qué falló). Al volver al listado mientras se genera, ves que sigue en curso. Si cierras o recargas la pestaña del navegador antes de que termine, el archivo se genera igual pero tendrás que exportar de nuevo para descargarlo. Si algo falla, la pantalla lo dice y puedes intentarlo otra vez. Cuando la descarga empieza, el aviso «Descarga lista: …» se borra solo a los 8 segundos.

## Auditoría

Cada exportación queda en la auditoría como una consulta de `kernel.export.run`, con tu usuario, el formato y el filtro usado. Solo tú (y el administrador de la empresa) pueden ver tus exportaciones grandes.
