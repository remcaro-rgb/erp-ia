---
title: Plantillas PDF e Imprimir
routes:
  - /core/parametros/plantillas
  - /accounting/parametros/plantillas
processes:
  - kernel.doc_template.print
  - kernel.doc_template.save
  - kernel.doc_template.set_default
---

# Plantillas PDF e Imprimir

Todo maestro y todo documento se puede **imprimir** en PDF: un registro (con su plantilla de registro) o un listado (con su plantilla de listado). El mismo PDF de registro es el que se envía por correo con **Notificar** y en los avisos por estado.

## Imprimir un registro

1. Abre el registro y guarda tus cambios (con cambios sin guardar, Imprimir dice «Guarda los cambios antes de imprimir»).
2. Pulsa **Imprimir** en la barra de acciones.
3. El PDF se descarga con la plantilla predeterminada de la empresa para ese tipo de registro o, si no hay, con la plantilla del sistema: membrete, datos del registro, la tabla de líneas y el número de página.

## Imprimir un listado

En el listado de un maestro o un documento, **Imprimir** genera el PDF de lo que ves: los filtros, el orden y las columnas visibles, de todas las páginas, con la plantilla de listado. Un listado de más de 2.000 filas no se imprime: fíltralo o usa **Exportar › PDF** (guía [Exportar](exportar.md)).

## Lo que sale en el PDF

- Solo lo que tú puedes ver: un campo enmascarado u oculto para tu rol sale vacío, y un registro que una regla de **Acceso** te oculta no aparece.
- El dinero sale como $ 1.234.567,00 y las fechas en la zona horaria de la empresa.
- Cada impresión queda en la auditoría, con la plantilla y su versión.

## Cambiar cómo se ve el PDF

El administrador de la empresa diseña las plantillas en **Parámetros › Plantillas PDF** de cada módulo: bloques de texto, variables (`empresa.nombre`, `empresa.nit`, `fecha_impresion`…), campos del registro, la tabla de líneas, el logo y el número de página, sobre un PDF de fondo (membrete) si lo quiere. Cada vez que guarda se crea una versión nueva, y **Predeterminada para…** elige la que usan Imprimir y los correos. Los pasos completos están en la guía [Parámetros de maestros y documentos](parametros.md), sección «Plantillas PDF».

## Desde el asistente

Pídele «imprime en PDF el comprobante NC-2026-0042»: el asistente genera el mismo PDF, con tus permisos. Imprimir es una consulta: no cambia nada y no pide confirmación.

## Si algo no funciona

- «No se pudo imprimir»: el aviso dice el motivo. Si el registro tiene cambios sin guardar, guárdalo primero.
- El logo o el membrete no salen: pide al administrador que revise la plantilla predeterminada en Parámetros.
