---
title: "Tasas de cambio: la TRM diaria, tasas manuales y reemplazar una TRM"
routes:
  - /exchange-rates
processes:
  - core.exchange_rate.set
  - core.exchange_rate.override_official
  - core.exchange_rate.import_official
  - core.exchange_rate.for_date
---

# Tasas de cambio

En **Núcleo › Parámetros › Tasas de cambio** están las tasas que usa la empresa para pasar una moneda extranjera a pesos: cuántos pesos vale una unidad de cada moneda, un valor por día. Por ejemplo, `USD 4.123,45` quiere decir que un dólar vale $ 4.123,45 ese día. Las tasas se ven con hasta seis decimales.

Cada fila dice la **Moneda**, la **Fecha**, la **Tasa**, su **Origen** (TRM o Manual), una **Nota** y, cuando hace falta, la **TRM publicada**. Solo tu empresa ve sus tasas.

## Qué es la TRM

La **TRM** (Tasa Representativa del Mercado) es la tasa del dólar que certifica cada día la Superintendencia Financiera de Colombia. Es la tasa con la que, por regla general, se registra una factura en dólares. La TRM existe solo para el dólar (USD); para el euro (EUR) y las demás monedas no hay tasa oficial y se registran a mano.

Una TRM vale para uno o varios días. La que se certifica un viernes vale para el sábado, el domingo y el lunes: por eso, al traerla, se registran tres filas, una por día.

## La importación diaria

Cada mañana, después de las 7:00 (hora de la empresa), el sistema trae la TRM del día por su cuenta y la registra con origen **TRM**. Lo hace solo para las empresas que usan otra moneda: las que ya tienen alguna tasa registrada o una lista de precios en una moneda distinta del peso. Si tu empresa no usa otra moneda, no pasa nada.

También puedes traerla cuando quieras con el botón **Traer TRM** de la pantalla. El mensaje dice cuántas tasas nuevas se registraron.

**La importación nunca cambia una tasa manual.** Si un día ya tiene una tasa que alguien escribió, ese día se deja igual y en la columna **TRM publicada** queda la TRM que salió ese día, para que puedas compararlas.

### Si la fuente no responde

Si no se puede leer la TRM (la fuente oficial no responde o todavía no ha publicado la tasa), no se registra nada y el administrador recibe en **Inicio** la recomendación «No se pudo traer la TRM», con la moneda y la fecha. Llega una sola recomendación por día, aunque el sistema lo intente otra vez. Cuando la TRM de ese día se trae bien (sola o con **Traer TRM**), la recomendación se cierra.

Mientras tanto puedes registrar la tasa a mano, como se explica abajo.

## Registrar una tasa manual

1. Abre **Tasas de cambio** y pulsa **Registrar tasa**.
2. Elige la **Moneda** (por ejemplo EUR), la **Fecha** y escribe la **Tasa** en pesos por unidad. Si quieres, añade una **Nota** (por ejemplo «Tasa del banco»).
3. Guarda. La fila queda con origen **Manual**.

Si ese día ya tenía una tasa manual, la nueva la reemplaza. Si ese día ya tiene la **TRM**, el sistema no deja escribir encima: dice «Ya hay una TRM para USD el …» y te remite a **Reemplazar TRM**. La moneda de la empresa (el peso) no lleva tasa: siempre vale 1.

## Reemplazar una TRM

A veces hay que usar otra tasa en un día que ya tiene la TRM (por ejemplo, la tasa de un reintegro del banco). Eso es **Reemplazar TRM** y es un cambio delicado.

1. En **Registrar tasa** escribe la moneda, la fecha y la nueva tasa, y pulsa **Registrar tasa**. Como ese día tiene la TRM, el sistema lo dice y aparece el botón **Reemplazar TRM**.
2. Escribe en **Nota** por qué la reemplazas y pulsa **Reemplazar TRM**.
3. Escribe el código de tu aplicación de autenticación.

Lo que pasa:

- Pide el **segundo factor** (el código de tu aplicación de autenticación).
- Pide una **nota** que explique el motivo.
- La fila pasa a origen **Manual**; la TRM que tenía queda en **TRM publicada**.
- La auditoría guarda quién lo hizo, cuándo, y el valor anterior y el nuevo.

Puedes pedírselo al asistente («reemplaza la TRM del 8 de noviembre por 4.150 porque…»): te muestra la tarjeta de confirmación y te pide el código en el chat. El administrador decide en **Administración › Procesos sensibles** qué otros procesos piden el segundo factor.

## Qué hace un documento sin tasa

Un documento en moneda extranjera (una factura de exportación en dólares, por ejemplo) toma la tasa de esta tabla para su fecha. Si ese día no hay tasa, usa la más reciente de los **tres días anteriores** (así un domingo o un festivo usan la del último día con tasa). Si tampoco la hay, el documento no se puede crear en esa moneda hasta que registres la tasa aquí o la escribas en el documento.

En la empresa de demostración hay tres tasas manuales del dólar (anteayer, ayer y hoy, la de hoy en 4.123,45, «Tasa de demostración»): la exportación a Northwind Roasters toma la de su fecha (guía **Pagos de clientes**, «La diferencia en cambio»).

## Preguntarle al asistente

Puedes preguntar «¿Cuál es la TRM de hoy?» o «¿a cuánto estaba el euro el 3 de noviembre?». El asistente contesta con la tasa, la fecha de la que viene y si es TRM o manual.

## Quién puede hacer qué

- **Ver** las tasas: quien tenga la pantalla **Tasas de cambio** en su menú; los formularios de documentos en otra moneda consultan la tasa del día para cualquier usuario que pueda crearlos.
- **Registrar tasas** y **Traer TRM**: el administrador y los roles a los que se les dé (en la empresa de demostración, el contador).
- **Reemplazar TRM**: el administrador y los roles a los que se les dé, siempre con el segundo factor.

Temas relacionados: [Parámetros de maestros y documentos](parametros.md) · [El asistente](asistente.md) · [Administración de la empresa](administracion.md).
