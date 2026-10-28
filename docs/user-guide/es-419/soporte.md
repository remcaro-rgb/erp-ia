# Pedir ayuda: tickets de soporte

Si algo no funciona, tienes una duda o necesitas que cambien algo, abre un **ticket** en **Soporte**. El equipo de soporte lo responde ahí mismo y tú ves la respuesta en el ticket.

## Abrir un ticket

1. Entra a **Soporte** en el menú de módulos, o pulsa **⌘K** (Ctrl+K) y escribe «ticket» para elegir **Crear ticket de soporte**.
2. Pulsa **Nuevo ticket**.
3. Elige el **Tipo**: **Error** (algo falla), **Pregunta** (cómo se hace algo) o **Solicitud** (algo que necesitas).
4. Escribe un **Título** corto y cuenta qué pasó o qué necesitas.
5. Pulsa **Enviar ticket**. El ticket se abre a la derecha con su número (N.º) y su identificador.

## El contexto que se adjunta

Para que soporte entienda el caso sin preguntarte todo, el ticket lleva, si no lo quitas:

- la **pantalla** en la que estabas antes de abrirlo (por ejemplo `/parties`),
- el **texto seleccionado** en esa pantalla, si habías marcado alguno,
- los **errores de consola** que el navegador registró.

Antes de enviar ves un resumen en «Contexto que se adjunta». Desmarca **Adjuntar el contexto de la pantalla** si no quieres enviarlo. Tu administrador puede ocultar el contexto a ciertos roles: es un dato sensible por defecto.

## Seguir la conversación

Abre el ticket desde la lista (clic en la fila). Tiene cuatro pestañas:

- **Datos**: tipo, estado, prioridad, descripción y contexto.
- **Mensajes**: la conversación. Escribe en **Tu respuesta** y pulsa **Responder**.
- **Datos adicionales**: los campos que definió tu administrador.
- **Archivos**: adjunta capturas o documentos (hasta 25 MB cada uno, con una etiqueta).

El **estado** cambia solo: **Abierto** cuando esperas a soporte, **Respondido** cuando soporte te contestó, **Cerrado** cuando el caso terminó. Si respondes un ticket **Respondido**, vuelve a **Abierto**. Un ticket **Cerrado** ya no recibe respuestas: abre uno nuevo.

## Quién ve qué

- Tú ves **tus** tickets. Un compañero no ve los tuyos ni tú los suyos.
- El **equipo de soporte** (los roles que pueden cerrar tickets) ve todos los tickets de la empresa activa, puede dejar **notas internas** y cierra los tickets con **Cerrar ticket**.
- Las **notas internas** solo las ve el equipo de soporte; no aparecen en tu conversación.
- Si cambias de empresa, ves los tickets de esa empresa.

## Permisos

Cada acción es un proceso con su permiso, que asigna el administrador del rol: **Crear ticket de soporte** (`support.ticket.create`), **Responder** (`support.ticket.reply`, también para adjuntar archivos), **Cerrar** (`support.ticket.close`, el que marca a una persona como equipo de soporte) y **Consultar** (`support.ticket.consult`). Si tu empresa no tiene habilitado el módulo de soporte, la opción no aparece.

## Auditoría

Abrir, responder y cerrar un ticket queda en la auditoría con quién lo hizo y desde dónde. Abrir un ticket publica además el evento `support.ticket.created`.
