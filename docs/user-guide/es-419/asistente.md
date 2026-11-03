---
title: "El asistente: preguntar, pedir acciones y confirmar"
routes:
  - /
processes:
  - kernel.record.notify
  - kernel.doc_template.print
  - kernel.data.query
  - kernel.help.search
---

# El asistente: preguntar, pedir acciones y confirmar

El **Asistente** es el panel de la derecha. Le escribes en español, como le hablarías a un compañero, y él consulta datos, te explica cómo se hace algo, te lleva a una pantalla o prepara una acción para que tú la confirmes. Trabaja **con tus permisos**: solo ve y puede proponer lo que tu rol ya puede hacer en la aplicación.

## Abrir el panel y preguntar

1. Pulsa **Asistente** en la barra superior (el panel mide 400 px y puedes cerrarlo con el mismo botón sin perder la conversación).
2. Escribe en la caja de abajo y pulsa **Enter** o la flecha **↑**. También puedes escribir una frase en **⌘K** y elegir **Preguntar al asistente**: el panel se abre y la frase se envía.
3. Mientras responde ves «Pensando…» y el texto va apareciendo. El botón **■** detiene la respuesta. Si subes en la conversación para releer algo, el panel deja de bajar solo mientras llega la respuesta y aparece el botón **Ir al final ↓** para volver abajo; al enviar una pregunta nueva vuelve al final por su cuenta.

El asistente sabe en qué pantalla estás (arriba del panel dice «Contexto: …») y, si estás en un registro, cuál es. Por eso puedes preguntar «¿cuál es su saldo?» estando en la ficha de un tercero.

Ejemplos:

- «¿Cuántos clientes hay en Medellín?»
- «Muéstrame los productos sin existencias.»
- «¿Cómo importo terceros desde Excel?» (busca en estas guías y te da los pasos y un enlace)
- «Llévame a productos.» o «Abre la ficha de Café del Norte.» (el asistente abre la pantalla en una pestaña)
- «Reporta un error: la exportación no baja el NIT como texto.» (propone un ticket de soporte)

Las respuestas muestran negrita, listas y enlaces **solo a pantallas de la aplicación**. El asistente nunca carga imágenes ni abre páginas externas.

## Consultas: la tabla de resultados

Cuando preguntas por datos (`kernel.data.query`), el asistente responde con una tabla con los mismos formatos de los listados: dinero como `$ 1.234.567,00`, fechas y horas en la zona horaria de tu empresa, «Sí» y «No», y un guion cuando no hay valor. Los campos que tu rol no puede ver no aparecen, y los enmascarados se muestran como ••••••.

- El nombre de cada fila y los registros que menciona (el proveedor de un producto, por ejemplo) son **enlaces** a su página, como en los listados (guía **Listados**, «Enlaces a registros»); sin enlace cuando tu rol no puede consultar ese tipo de registro.
- Una consulta trae **hasta 50 filas**. Si hay más, la tabla lo dice («Resultado truncado a 50 filas») y verás «50 de 312»: afina la pregunta para ver el resto.
- **Abrir como grid**: abre el listado de ese tipo de registro en su pestaña, con los mismos filtros y orden de la consulta, para trabajar con todos los registros. Solo aparece para los registros que tienen listado.
- **Excel**: descarga la consulta a un archivo Excel con las mismas condiciones, como en [Exportar un listado](exportar.md).
- **Guardar reporte**: aparece desactivado («Fase 5»). Guardar reportes llega en una fase posterior.

## Pedir una acción: la tarjeta de confirmación

El asistente **nunca cambia nada por su cuenta**. Si le pides crear, modificar o eliminar algo, te muestra una **tarjeta de confirmación** con un encabezado azul claro, lo que va a hacer línea por línea y el permiso con el que se ejecuta. Los valores se leen como en los formularios: «Tipo de tercero: Cliente», «Municipio: Medellín»; los códigos fiscales conservan su código delante del nombre («Tipo de documento: 31 · NIT», «Responsabilidades fiscales: R-99-PN · No responsable · no aplica»).

- **Confirmar**: ejecuta la acción, una sola vez aunque pulses dos veces, y queda registrada en la auditoría con el origen «asistente».
- **Editar**: los valores de la tarjeta se vuelven campos. Cambia los que quieras y pulsa **Enviar cambios**: el asistente recibe «Cambia Ciudad a Medellín» como un mensaje nuevo y te prepara una tarjeta nueva. Editar no ejecuta nada, y la tarjeta anterior queda cancelada. **Volver** cierra la edición sin cambios.
- **Cancelar**: descarta la tarjeta; no cambia nada.

Una tarjeta decidida queda en la conversación con su resultado («Listo · la acción se ejecutó» o «Cancelada · nada cambió»). Una tarjeta **vence a los 15 minutos**; entonces dice que venció y debes pedir la acción otra vez. Si la acción no se puede hacer (por ejemplo, falta un permiso o un dato), la tarjeta muestra el motivo y sigue pendiente para que lo corrijas o la canceles.

#### Maestros y documentos

Con el asistente también puedes cambiar el estado de un maestro o un documento, con las mismas reglas de la pantalla (guía [Maestros y documentos](maestros-y-documentos.md)):

- «aprueba el comprobante NC-2026-0042», «no apruebes el comprobante NC-2026-0042: falta el soporte», «anula el comprobante NC-2026-0042, quedó duplicado»: **Guardar**, **Enviar a aprobación**, **Aprobar**, **No aprobar**, **Anular** y **Eliminar** siempre llegan como tarjeta de confirmación; nada cambia antes de **Confirmar**.
- «envía por correo el comprobante NC-2026-0042 a tesoreria@empresa.co»: **Notificar** sale del sistema, así que también pide confirmación (guía [Notificaciones por correo](notificaciones.md)).
- «imprime en PDF el comprobante NC-2026-0042»: **Imprimir** es una consulta y no pide confirmación (guía [Plantillas PDF e Imprimir](plantillas-pdf.md)).
- Si una regla de **Acceso** no te deja modificar ese registro, el asistente no te muestra tarjeta: te dice que no tienes permiso sobre él. Si no puedes verlo, responde como si no existiera (guía [Acceso por registro](acceso-por-registro.md)).

## Acciones sensibles: el código de verificación

Algunas acciones (las que el administrador marcó como sensibles, como cambiar un cupo de crédito) piden **verificación en dos pasos**. Su tarjeta lleva una zona «Verificación requerida» y **Confirmar** está desactivado hasta que:

1. Escribes (o pegas) el **código de 6 dígitos** de tu app de autenticación (el mismo de [Ingresar y verificación en dos pasos](ingreso-y-2fa.md)). La caja del código toma el cursor cuando aparece la tarjeta, salvo que estés escribiendo en otro campo.
2. Al sexto dígito el código se verifica solo (también puedes pulsar **Verificar**). Aparece «Verificado», Confirmar se activa y el cursor pasa a **Confirmar**.
3. Pulsas **Confirmar** (o Enter). El código sirve para esa sola confirmación y vale 5 minutos; para otra acción sensible se pide uno nuevo.

Si el código es incorrecto verás «Código incorrecto». Tras varios intentos fallidos debes esperar unos minutos.

## La conversación

- El panel recuerda tu última conversación: si recargas la página la verás de nuevo, con las tarjetas pendientes todavía confirmables (mientras no hayan vencido) y las decididas con su resultado.
- **Nueva conversación** empieza de cero.
- Al volver a abrir una conversación el panel muestra hasta los **últimos 100 mensajes** (los anteriores se conservan, pero no se muestran). Si no se puede cargar tu conversación, el panel lo dice y puedes escribir para empezar una nueva.
- Si recargas la página mientras el asistente responde, la respuesta no se pierde: se guarda al terminar. Recarga de nuevo unos segundos después para verla (la respuesta en vivo no se retoma).
- Cada mensaje puede tener hasta 4.000 caracteres.

## Límites y avisos

- Cada empresa tiene un tope mensual de uso de IA. Al alcanzarlo, el asistente avisa y deja de responder hasta que el administrador lo amplíe; el resto de la aplicación sigue funcionando.
- Si no tienes permiso para algo, el asistente no lo ofrece y te lo explica. Pídele al administrador de tu empresa el permiso o crea un [ticket de soporte](soporte.md).
- Una respuesta del asistente puede equivocarse: revisa siempre la tarjeta antes de confirmar.

## El asistente según el tamaño de la pantalla

- **Desde 1280 px** el asistente es el panel fijo de 400 px a la derecha.
- **De 768 a 1279 px** se abre **sobre** la página, sin angostarla.
- **Por debajo de 768 px** ocupa toda la pantalla; el campo de texto sube con el teclado de la pantalla.
- En todos los casos tiene su propio botón **Cerrar** y la tecla **Esc** lo cierra. Al abrirlo el cursor queda en el campo de texto, y al cerrarlo vuelve al botón **Asistente**.

## Tablas de resultados

Una tabla que muestra el asistente trae primero hasta **seis columnas** de la vista por omisión del listado (la identidad primero), con los mismos nombres, valores y enlaces del listado: un estado se lee «Cliente», no el código interno, y una persona es un enlace a su página. **Ver todas las columnas** despliega el resto en el mismo lugar y **Ver menos columnas** lo repliega. **Abrir como listado** y **Excel** no cambian.
