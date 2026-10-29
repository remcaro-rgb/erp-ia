---
title: Moverse por el sistema
routes:
  - /
processes:
  - kernel.user_prefs.set
---

# Moverse por el sistema

Todas las pantallas de ERP-IA comparten el mismo marco: una barra azul oscura arriba, una fila de pestañas debajo y, a la derecha, el panel del asistente.

## La barra de arriba

De izquierda a derecha:

- **ERP-IA**: el nombre del sistema.
- **La empresa activa** (con una flecha ▾): abre la lista de tus empresas. La que está marcada con ✓ es en la que trabajas; cada una muestra su NIT. Elige otra para cambiar. Todo lo que ves (listados, registros, permisos) pertenece a la empresa activa, y cada empresa recuerda sus propias pestañas y su propio tema. **Agregar empresa** aparece desactivada: por ahora no se agregan empresas desde la pantalla.
- **El módulo activo** (por ejemplo **Núcleo**): abre **Módulos contratados**, la lista de módulos que tu empresa tiene y que tu rol puede usar, con el número de opciones de cada uno. Al elegir un módulo se abre su primera pantalla, salvo que ya tengas una de ese módulo abierta en una pestaña.
- **Las opciones del módulo** (a la derecha del botón de módulo): por ejemplo **Inicio · Terceros · Productos · Categorías · Importar datos**. La opción de la pantalla en que estás aparece subrayada. **Inicio** está siempre en el primer módulo.
- **La caja ⌘K**: abre la paleta de comandos (ver abajo).
- **El botón de tema**: alterna el aspecto.
- **La campana**: las notificaciones. El número sobre la campana aparece solo cuando hay algo sin leer; por ahora siempre dice «Sin novedades».
- **Asistente**: abre o cierra el panel del asistente (también con **Ctrl+/**, o **⌘/** en Mac).
- **Tu usuario** (el círculo con tus iniciales): muestra tu nombre, correo y roles, permite cambiar el tema y tiene la opción **Salir**.

Una opción o un módulo solo aparece si tu empresa lo tiene habilitado y tu rol puede usarlo.

## Las pestañas

Cada pantalla que abres queda en una pestaña de la fila que está debajo de la barra azul.

- **Inicio** es fija: no se cierra.
- Al abrir una opción del menú se abre su pestaña. Si ya estaba abierta, el sistema te lleva a ella en lugar de abrir otra.
- Al hacer clic en una fila de un listado, el registro se abre en una pestaña propia con el nombre del registro. **Nuevo** abre una pestaña «Crear …» con el formulario vacío.
- Si el registro no existe o tu rol no tiene acceso a él (por ejemplo, un proveedor cuando tu rol solo ve clientes), la pestaña dice «No encontrado» y la página explica «No encontramos este registro o no tienes acceso a él», con el botón **Volver al inicio**.
- La **✕** de cada pestaña la cierra. Al cerrar la pestaña activa pasas a la vecina.
- El botón **+** abre la paleta de comandos para elegir la pantalla de una pestaña nueva.
- **Cerrar todas ✕** (a la derecha, solo aparece si hay pestañas que cerrar) cierra todas menos Inicio. Antes pide confirmación y te dice cuáles se cerrarán: «Los formularios sin guardar se perderían».
- Se mantienen hasta 30 pestañas; si abres más, se cierran las más antiguas.

Tus pestañas se guardan en tu usuario, por empresa: al volver a ingresar, o desde otro computador, encuentras las mismas.

## La paleta de comandos (⌘K)

Pulsa **⌘K** (en Windows y Linux, **Ctrl+K**) o haz clic en la caja de la barra. Se abre una ventana para escribir:

1. Escribe parte del nombre de lo que buscas. Por ejemplo «terc», «productos» o «ticket». También encuentra por palabras relacionadas («clientes», «proveedores», «nit», «iva», «ayuda») y no distingue tildes ni mayúsculas.
2. Verás dos tipos de resultados: **Ir a …** (abre esa pantalla) y **Crear …** (abre la pantalla con el formulario de un registro nuevo; solo aparece para lo que tu rol puede crear: tercero, producto, categoría de producto, ticket de soporte).
3. Muévete con **↑ ↓**, ejecuta con **Enter** y cierra con **Esc**.

Si lo que escribes no coincide con nada, o es una frase de tres palabras o más, el primer resultado es **Preguntar al asistente: «…»**. Al elegirlo se abre el panel del asistente y tu frase se le envía como pregunta (ver [El asistente](asistente.md)).

## El tema: claro, oscuro o automático

El botón de tema de la barra (y la opción **Tema** del menú de tu usuario) va cambiando en este orden: **Automático** (sigue al sistema operativo), **Claro** y **Oscuro**. El cambio se aplica al instante y se guarda para tu usuario en cada empresa.

## El panel del asistente

El botón **Asistente** abre o cierra un panel a la derecha. Muestra el contexto de la pantalla en que estás y la conversación con el asistente; cerrarlo no la pierde. Cómo usarlo está en [El asistente](asistente.md).

**Ctrl+/** (en Mac, **⌘/**) hace lo mismo desde cualquier pantalla: si el panel está cerrado lo abre con el cursor listo en la caja para escribir; si está abierto lo cierra y el cursor vuelve a la pantalla.

## Usar el teclado

- **Saltar al contenido**: la primera vez que pulsas **Tab** en una pantalla aparece arriba a la izquierda el enlace «Saltar al contenido». Pulsa **Enter** y el cursor pasa directo a la pantalla, sin recorrer la barra ni las pestañas.
- El elemento que tiene el cursor siempre se ve con un borde azul.
- **⌘K** o **Ctrl+K** abre la paleta de comandos; **Ctrl+/** o **⌘/** abre o cierra el asistente.
