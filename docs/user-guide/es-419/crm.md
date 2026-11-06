---
title: "CRM: prospectos, embudos, oportunidades y actividades"
routes:
  - /crm/leads
  - /crm/pipelines
  - /crm/opportunities
  - /crm/activities
processes:
  - crm.lead.create
  - crm.lead.update
  - crm.lead.convert
  - crm.pipeline.create
  - crm.pipeline.update
  - crm.opportunity.create
  - crm.opportunity.stage_move
  - crm.opportunity.reassign
  - crm.activity.create
---

# CRM

El módulo **CRM** lleva el camino de una venta antes de que exista el pedido: **prospectos** (quién podría comprarte), **oportunidades** (la negociación con cada cliente), el **embudo** por el que avanzan y las **actividades** (llamadas, reuniones, notas, pagos) que dejas registradas.

Cada listado tiene su botón **Nuevo** y cada registro se abre en su propia pestaña con un clic. Todo esto también lo puedes pedir al **asistente** (guía **El asistente**), que ejecuta las mismas acciones con tus permisos y te pide confirmar cada cambio.

## Prospectos

Un prospecto es una empresa o persona que aún no es cliente. **CRM › Maestros › Prospectos** › **Nuevo**:

1. Escribe el **Nombre** y, si los tienes, el **Contacto**, el **Correo**, el **Indicativo** y el **Teléfono** (van juntos). El **Origen** dice de dónde llegó (sitio web, referido, evento, llamada, redes u otro).
2. El prospecto queda a tu nombre como **Vendedor**. Muévelo por las etapas **Nuevo**, **Contactado**, **Calificado** o **Descartado** cuando cambie su situación. **Convertido** lo pone el sistema.
3. Si ya conoces su **Tipo de persona**, **Tipo de documento** y **Número de documento**, escríbelos ahora; si no, los pides al convertirlo.
4. Pulsa **Guardar** en la barra de acciones. La etapa se ve junto a **Datos**.

## Convertir un prospecto en cliente

Con el prospecto abierto, pulsa **Convertir en cliente**. Se abre un panel con el **Tipo de persona**, el **Tipo de documento** y el **Número de documento** (para una persona natural, también **Primer nombre** y **Primer apellido**), el **Título de la oportunidad**, el **Valor de la oportunidad** y el **Cierre esperado**. Pulsa **Convertir**. El sistema:

1. Crea el **tercero** (cliente) con la misma validación DIAN de **Terceros**. Un número de documento con formato incorrecto, o repetido, detiene la conversión y no deja nada a medias. Para una persona natural te pide primer nombre y primer apellido.
2. Crea una **oportunidad** en el embudo predeterminado, a nombre del mismo vendedor, con el valor que indiques.
3. Marca el prospecto como **Convertido** y deja enlaces al cliente y a la oportunidad.

El cliente recién creado **no está listo para facturar** hasta que completes sus datos DIAN (departamento, municipio, dirección, correo para facturas) y cargues sus archivos. Ábrelo desde el enlace y complétalo; la guía **Terceros** explica cómo.

Necesitas permiso para crear terceros. Si no lo tienes, pide a un administrador que haga la conversión. Si el cliente ya existe, la conversión puede enlazarlo en lugar de crear otro.

## Embudos y etapas

**CRM › Maestros › Embudos** define las etapas por las que pasa una negociación, en orden: primero las **abiertas** (Nuevo, Propuesta, Negociación…), luego una **Ganada** (100 %) y una **Perdida** (0 %). Cada etapa abierta tiene su probabilidad. El primer embudo que creas es el predeterminado. Si la empresa no tiene ninguno cuando se necesita, el sistema crea uno estándar llamado **Ventas**.

Un embudo nuevo trae las etapas estándar (Nuevo, Calificado, Propuesta, Negociación, Ganada, Perdida). Puedes renombrar, reordenar (↑ ↓) y agregar etapas con **Agregar etapa**, y guardar con **Guardar**. Una etapa con oportunidades no se puede quitar: mueve primero esas oportunidades.

## Oportunidades

**CRM › Documentos › Oportunidades** › **Nuevo**: escribe el **Título**, el cliente (o el prospecto), el **Valor**, el **Cierre esperado** y, si quieres, las líneas de lo que se negocia (producto o descripción, cantidad y precio; sin valor, se suma de las líneas). Se numera `OP-…` y empieza en la primera etapa abierta del embudo.

La oportunidad grabada muestra sus **Datos**, su resultado (**Abierta**, **Ganada** o **Perdida**) y sus líneas.

- **Mover de etapa**: elige la **Etapa** y pulsa **Mover de etapa**; cada cambio queda auditado con la etapa anterior y la nueva. Pasarla a **Perdida** pide el **Motivo de la pérdida**. Una oportunidad ganada o perdida ya no se mueve.
- **Ganada por pedido**: cuando se confirma el pedido que salió de la oportunidad, el sistema la cierra como **Ganada** sola.
- **Cada vendedor ve solo sus oportunidades** y sus actividades. Quien tiene permiso de **reasignar** (el jefe de ventas) las ve todas y las pasa de un vendedor a otro.

## Actividades

**CRM › Reportes › Actividades** lista las llamadas, reuniones, correos, notas, tareas y pagos de tus oportunidades, prospectos y clientes. **Nuevo** registra una: el **Tipo**, el **Asunto**, sobre qué es (una **Oportunidad**, un **Prospecto** o un **Tercero**), cuándo **Vence** y si ya está **Hecha**. Una actividad registrada no se edita. Cuando se paga una factura que salió de una oportunidad, el sistema deja sola una actividad de **Pago** con el número de la factura.
