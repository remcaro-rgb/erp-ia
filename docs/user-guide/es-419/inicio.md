---
title: Primeros pasos en ERP-IA
routes:
  - /
processes:
  - kernel.home.kpis
  - kernel.home.recent
  - kernel.recommendation.list
  - kernel.recommendation.decide
  - kernel.user_prefs.set
---

# Primeros pasos en ERP-IA

ERP-IA es el sistema de gestión de tu empresa en el navegador. Hoy te permite mantener los **terceros** (clientes, proveedores y empleados), los **productos** y sus **categorías** con todos los datos que exige la facturación electrónica de la DIAN, adjuntar **archivos** a cada registro, **importar** y **exportar** listados en Excel o CSV y pedir ayuda al equipo de **soporte**.

## Lo que necesitas antes de empezar

- El correo y la contraseña que te dio el administrador de tu empresa.
- Una app de autenticación en tu celular (Google Authenticator, Authy o 1Password) si tu rol exige verificación en dos pasos. La guía **Ingresar y verificación en dos pasos** lo explica.

## Tu primera sesión

1. Abre ERP-IA en el navegador e ingresa con tu correo y contraseña. Si es tu computador de siempre, marca **Recordarme en este dispositivo por 30 días**.
2. Si tu rol lo exige, escribe el código de 6 dígitos de tu app de autenticación.
3. Llegas a **Inicio**, la primera pestaña: tu panel con los indicadores de tu empresa, las recomendaciones para ti, los últimos registros que tocaste y atajos de ayuda. Más abajo, en **La pantalla de Inicio**, se explica cada tarjeta y cómo acomodarlas a tu gusto.
4. Abre el menú **Módulos** (arriba, junto al nombre de la empresa) y elige **Núcleo** o **Soporte**. Al lado aparecen las opciones del módulo: **Terceros**, **Productos**, **Categorías** e **Importar datos** en Núcleo; **Soporte** en el módulo de soporte.
5. Pulsa **Terceros** para ver el listado. Para crear uno, pulsa **Nuevo**.

## Cómo está organizada la pantalla

- **Barra azul oscura de arriba**: el nombre de la empresa (para cambiar de empresa si tienes más de una), el menú **Módulos**, las opciones del módulo, la caja **⌘K** para ir a cualquier pantalla, el botón de **tema** (claro, oscuro o automático), las notificaciones, el botón **Asistente** y tu usuario (con la opción **Salir**).
- **Fila de pestañas**: cada pantalla que abres queda en una pestaña. Puedes tener varias abiertas y volver a cualquiera.
- **Zona de trabajo**: el listado o el registro que tienes abierto.
- **Panel del Asistente** (a la derecha): por ahora indica que el asistente estará disponible muy pronto. Mientras tanto usa **⌘K** (Ctrl+K en Windows).

La guía **Moverse por el sistema** explica cada parte con detalle.

## La pantalla de Inicio

Inicio te saluda por tu nombre y reúne tus tarjetas en un tablero de cuatro columnas. Cada persona ve solo lo que su rol permite: si una tarjeta no aparece, tu rol no tiene acceso a esa información.

### Indicadores

La tarjeta **Indicadores** muestra los números del momento, calculados con tus permisos. Su encabezado dice a qué hora se leyeron («Actualizado 10:42», en la hora de tu empresa); para ver números más recientes, vuelve a abrir Inicio o recarga la página. **Recomendaciones para ti** lo indica igual.

Bajo cada número verás una **línea de tendencia de los últimos 14 días** (el más reciente a la derecha). En Terceros, Productos y Tickets muestra cuántos se crearon cada día; en Uso de IA, los tokens de cada día (los de tu empresa si eres administrador, los tuyos si no). La línea sigue tus permisos, igual que el número, y se dibuja a escala: el día más bajo queda abajo y el más alto arriba, así que compara la forma, no la altura entre tarjetas. Si pasas el lector de pantalla por ella, dice «Tendencia 14 días: de X a Y» (el primer y el último día). Los días son los de la hora de tu empresa.

- **Terceros activos**: cuántos terceros hay activos y cuántos de ellos todavía no se pueden facturar (les faltan datos de la DIAN o archivos). Si tu rol solo ve clientes o solo proveedores, el número cuenta solo los que tú ves.
- **Productos**: cuántos hay y cuántos no se pueden facturar todavía.
- **Tickets de soporte**: los que siguen abiertos. Si no eres agente de soporte, cuenta solo los tuyos.
- **Uso de IA del mes**: si eres administrador, el porcentaje de los tokens incluidos que tu empresa ya usó este mes; si no, los tokens que tú has usado. Pasa a color de advertencia al llegar al 80 %.

Los indicadores de otros módulos aparecen aquí cuando tu empresa los contrata.

### Recomendaciones para ti

Son sugerencias que el sistema o un agente prepara para tu rol, con la explicación de por qué. **Nada se ejecuta solo.**

1. Lee la recomendación y pulsa el botón de la acción que propone, por ejemplo **Crear con el asistente**.
2. Si la acción es una pantalla, se abre. Si es una operación, se abre el **Asistente** con la petición ya escrita («Ejecuta … con …») y te muestra la **tarjeta de confirmación** con lo que va a pasar.
3. Revisa la tarjeta y pulsa **Confirmar** (o escribe el código de verificación si la operación lo exige). Mientras no confirmes, no cambia nada.
4. Si no te sirve, pulsa **Descartar**: la recomendación sale de tu lista.

Una recomendación que aceptas o descartas deja de mostrarse para todas las personas de tu rol, y queda registrada en la auditoría.

### Registros recientes

Los últimos 10 registros que creaste o modificaste, con su tipo, la acción y cuándo. Pulsa el nombre para abrirlo. No aparece lo que ya no tienes permiso de ver.

### Ayuda rápida

Atajos para preguntarle al asistente cómo hacer algo (crear un tercero, importar desde Excel, activar la verificación en dos pasos…). Al pulsar uno, el asistente recibe la pregunta y te responde con los pasos.

### Mover y cambiar el tamaño de las tarjetas

Inicio es tuyo: cada cambio se guarda para tu usuario y tu empresa, y nadie lo mueve por ti.

- **Mover**: arrastra una tarjeta por su encabezado (la barra con los puntos ⋮⋮) y suéltala sobre otra; toma su lugar. Con el teclado, enfoca el encabezado y pulsa **Enter** o **Espacio**: aparece el aviso «Modo mover» y las **flechas** mueven la tarjeta (izquierda y arriba la adelantan, derecha y abajo la atrasan); **Mayús + flechas** cambian su tamaño (izquierda y derecha las columnas, arriba y abajo el alto); **Esc** (o **Enter** otra vez) termina. **Alt + flecha izquierda o derecha** también mueve la tarjeta sin entrar al modo.
- **Cambiar el tamaño**: arrastra la esquina inferior derecha de la tarjeta. El ancho se ajusta a 1, 2, 3 o 4 columnas y el alto es libre (mínimo 160 px). Mientras cambias el tamaño (o cuando la tarjeta tiene el cursor del teclado), el encabezado muestra el tamaño actual, por ejemplo «2/4 · 300 px». Con el teclado, enfoca la esquina y usa las **flechas**: izquierda y derecha cambian las columnas, arriba y abajo el alto.
- **Restablecer tarjetas** (arriba a la derecha) devuelve todas las tarjetas a su orden y tamaño originales.

Tu disposición vuelve igual la próxima vez que entres, también desde otro computador.

## ¿Qué quieres hacer?

| Quiero… | Lee la guía |
| --- | --- |
| Entender las tarjetas de Inicio, moverlas o cambiarles el tamaño | Primeros pasos (La pantalla de Inicio) |
| Ingresar, activar la verificación en dos pasos o confirmar una acción sensible | Ingresar y verificación en dos pasos |
| Cambiar de empresa, abrir pestañas, usar ⌘K o cambiar el tema | Moverse por el sistema |
| Crear o buscar un cliente o proveedor | Terceros |
| Agregar las personas de contacto de un tercero | Contactos de un tercero |
| Crear un producto o servicio con sus impuestos | Productos |
| Definir los impuestos por defecto de un grupo de productos | Categorías de productos |
| Adjuntar el RUT, una ficha técnica u otro archivo | Archivos adjuntos |
| Ver los campos que mi empresa agregó a los registros | Datos adicionales |
| Ordenar, filtrar, guardar vistas o buscar con el filtro avanzado | Listados |
| Llevarme un listado a PDF, Excel o CSV | Exportar un listado |
| Cargar muchos registros desde Excel | Importar datos |
| Reportar un problema o hacer una pregunta | Soporte |

## Si algo no aparece

Cada empresa contrata los módulos que necesita y cada rol tiene sus permisos. Si no ves una opción del menú, un botón (por ejemplo **Nuevo** o **Importar**), una pestaña, un indicador o una tarjeta de Inicio, es porque tu empresa no tiene esa función habilitada o tu rol no la puede usar. Pídele al administrador de tu empresa que revise tus permisos, o abre un ticket en **Soporte**.
