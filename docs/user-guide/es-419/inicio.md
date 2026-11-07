---
title: Primeros pasos en Goliatt
routes:
  - /
processes:
  - kernel.home.kpis
  - kernel.home.recent
  - kernel.recommendation.list
  - kernel.recommendation.decide
  - kernel.user_prefs.set
---

# Primeros pasos en Goliatt

Goliatt es el sistema de gestión de tu empresa en el navegador. Hoy te permite mantener los **terceros** (clientes, proveedores y empleados), los **productos** y sus **categorías** con todos los datos que exige la facturación electrónica de la DIAN, adjuntar **archivos** a cada registro, **importar** y **exportar** listados en Excel o CSV y pedir ayuda al equipo de **soporte**.

## Lo que necesitas antes de empezar

- El correo y la contraseña que te dio el administrador de tu empresa.
- Una app de autenticación en tu celular (Google Authenticator, Authy o 1Password) si tu rol exige verificación en dos pasos. La guía **Ingresar y verificación en dos pasos** lo explica.

## Tu primera sesión

1. Abre Goliatt en el navegador e ingresa con tu correo y contraseña. Si es tu computador de siempre, marca **Recordarme en este dispositivo por 30 días**.
2. Si tu rol lo exige, escribe el código de 6 dígitos de tu app de autenticación.
3. Llegas a **Inicio**, la primera pestaña: tu panel con los indicadores de tu empresa, las recomendaciones para ti, los últimos registros que tocaste y atajos de ayuda. Más abajo, en **La pantalla de Inicio**, se explica cada tarjeta y cómo acomodarlas a tu gusto.
4. Abre el menú **Módulos** (arriba, junto al nombre de la empresa) y elige **Núcleo** o **Soporte**. Al lado aparecen las opciones del módulo: **Productos**, **Categorías** e **Importar datos** en Núcleo (**Terceros** está en Contabilidad, sección Maestros); **Soporte** en el módulo de soporte.
5. Pulsa **Terceros** para ver el listado. Para crear uno, pulsa **Nuevo**.

## Cómo está organizada la pantalla

- **Barra azul oscura de arriba**: el nombre de la empresa (para cambiar de empresa si tienes más de una), el menú **Módulos**, las opciones del módulo, la caja **⌘K** para ir a cualquier pantalla, el botón de **tema** (claro, oscuro o automático), las notificaciones, el botón **Asistente** y tu usuario (con la opción **Salir**).
- **Fila de pestañas**: cada pantalla que abres queda en una pestaña. Puedes tener varias abiertas y volver a cualquiera.
- **Zona de trabajo**: el listado o el registro que tienes abierto.
- **Panel del Asistente** (a la derecha): le escribes en español y consulta datos, te explica cómo hacer algo o prepara una acción para que la confirmes. Ábrelo o ciérralo con el botón **Asistente** de la barra superior o con **⌘/** (Ctrl+/ en Windows), que deja el cursor listo para escribir. La guía **El asistente** explica cómo usarlo.

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
- **Personalizar página de inicio** (junto a Restablecer tarjetas) decide qué indicadores y gráficos aparecen: se explica en la sección siguiente.

Tu disposición vuelve igual la próxima vez que entres, también desde otro computador.

### Pendientes del sistema y la campana

Además de las sugerencias de los agentes, **los propios procesos** dejan avisos cuando algo quedó a medias y alguien debe resolverlo, por ejemplo «Falta el costo de un producto» o «No se creó la factura automática». Se ven en tres lugares:

- En **Recomendaciones para ti**, con la etiqueta «Aviso de» y el módulo que lo dejó.
- En la **campana** de la barra azul: el número es cuántos avisos tienes abiertos y el menú muestra los cinco más recientes. **Ver todo en Inicio** abre esta pantalla.
- En el **Inicio del módulo** que lo dejó, en la tarjeta **Pendientes** (solo aparece cuando hay alguno).

**Quién los ve.** Cada aviso va a las personas cuyo rol puede corregir la causa: un costo faltante, a quien puede registrar ajustes de inventario; una factura automática que no se creó, a quien puede crear facturas. Si tu rol no tiene ese permiso, no lo ves en ninguna parte.

**Valores ocultos.** Si tu rol no puede ver un dato que el aviso menciona (por ejemplo, el número de la entrega), el aviso lo muestra como «—».

**El enlace.** **Abrir registro** lleva al registro del que habla el aviso. Si tu rol no puede consultarlo, el aviso dice **Sin acceso al registro** y en la campana te lleva a Inicio.

**Descartar.** Pulsa **Descartar** si ya no te sirve: sale de tu lista, de la campana y del Inicio del módulo para todas las personas que lo veían, y queda registrado en la auditoría. Si la misma causa vuelve a pasar, aparece un aviso nuevo.

**Se cierran solos.** Cuando la causa se corrige (llega una entrada con costo, la entrega se factura), el aviso se cierra sin que hagas nada. Si el mismo problema se repite antes de corregirlo, no se acumulan avisos: el que está abierto cuenta las veces. Los avisos cerrados o descartados se borran a los **90 días**.

### Inicio de cada módulo

Cada módulo tiene su propio **Inicio**: es el primer botón de la barra de opciones del módulo (bajo la barra azul) y abre una pestaña llamada «Inicio de Contabilidad», «Inicio de Núcleo», etc. La pestaña **Inicio** fija, la primera, sigue siendo el panel general de la empresa. El Inicio de un módulo reúne los **indicadores** (una tarjeta con los números) y los **gráficos** de ese módulo, con el mismo tablero que el Inicio general: se mueven y cambian de tamaño igual, y cada módulo guarda su propia disposición para tu usuario.

Todo se calcula con tus permisos: un indicador o gráfico que tu rol no puede consultar no aparece, y en los que sí aparecen solo entran los datos que tú puedes ver.

| Módulo | Indicadores | Gráficos |
|---|---|---|
| **Contabilidad** | Resultado, ingresos, gastos y costos y margen del mes; capital de trabajo y razón corriente; comprobantes contabilizados; pendientes de contabilizar; períodos abiertos; comprobantes en borrador | Ingresos y gastos por mes; resultado por mes; comprobantes por estado; principales gastos del mes |
| **Núcleo** | Terceros activos, clientes activos, proveedores activos, terceros nuevos del mes; productos y productos listos para facturar | Terceros por tipo; terceros por tipo de persona; terceros nuevos por día; productos por categoría |
| **Soporte** | Tickets abiertos, urgentes, estancados (más de 7 días) y resueltos en 30 días | Tickets por estado; tickets abiertos por prioridad; tickets recibidos por semana |
| **Sistema** | Uso de IA del mes, usuarios activos, acciones auditadas en 24 horas | Tokens de IA por día; acciones auditadas por día |
| **CRM** | Pipeline: el valor de las oportunidades abiertas | Pipeline por etapa |
| **Ventas** | Pedidos abiertos (abiertos, confirmados o con entregas parciales; abajo, cuántos están confirmados) | Pedidos por estado; pedidos confirmados en los últimos seis meses |
| **Inventario** | Stock bajo mínimo: los productos con stock mínimo cuya existencia está por debajo; abre **Existencias** | — |
| **Costos** | Costos faltantes: las salidas sin costo pendientes de resolver | — |
| **Facturación** | Por cobrar: el saldo de las facturas emitidas (en amarillo si alguna está vencida; abajo, cuántas y cuántas vencidas); Por facturar: el valor de lo despachado que aún no está en una factura; abre **Por facturar** | Ventas: el subtotal facturado en los últimos seis meses |
| **Pagos** | Recaudo: el dinero recibido en los recibos de caja del período en curso | Recaudo de los últimos seis meses |

Por cobrar solo aparece si puedes ver el total y los saldos de las facturas: si tu rol tiene oculto alguno de esos campos, la tarjeta no se muestra.

Cada tarjeta y cada gráfico es un enlace a la pantalla donde está el detalle. Los gráficos de barras muestran el valor sobre cada barra; los de línea, el último valor, y el lector de pantalla los lee completos («Ingresos: 2026-10 $ 1.000,00; …»). Pasa el cursor sobre una barra para ver su valor exacto.

### Personalizar página de inicio

El botón **Personalizar página de inicio**, junto a **Restablecer tarjetas**, abre una ventana con todos los indicadores y gráficos que tu rol puede ver en esa página, cada uno con una **descripción corta** de qué mide y un **interruptor**:

1. Pulsa **Personalizar página de inicio**.
2. Lee la descripción de cada indicador o gráfico y enciende o apaga su interruptor. El cambio se ve al instante y se guarda para tu usuario y tu empresa. **Activar todo** y **Desactivar todo** cambian la lista completa.
3. Pulsa **Listo**.

Lo que apagas se apaga en todas tus páginas de Inicio (la general y las de los módulos) y no se calcula, así que la página carga más rápido. Un indicador o gráfico nuevo que se agregue al sistema aparece encendido. Si apagas todo, la página te lo dice y el mismo botón sirve para volver a encenderlos. En el Inicio general la ventana lista los indicadores de todos los módulos (los gráficos viven en el Inicio de cada módulo). **Restablecer tarjetas** solo devuelve el orden y el tamaño; no cambia lo que encendiste o apagaste.

## ¿Qué quieres hacer?

| Quiero… | Lee la guía |
| --- | --- |
| Entender las tarjetas de Inicio, moverlas, cambiarles el tamaño o elegir qué indicadores y gráficos ver | Primeros pasos (La pantalla de Inicio, Inicio de cada módulo, Personalizar página de inicio) |
| Ingresar, activar la verificación en dos pasos o confirmar una acción sensible | Ingresar y verificación en dos pasos |
| Cambiar de empresa, abrir pestañas, usar ⌘K o cambiar el tema | Moverse por el sistema |
| Crear o buscar un cliente o proveedor | Terceros |
| Agregar las personas de contacto de un tercero | Contactos de un tercero |
| Crear un producto o servicio con sus impuestos | Productos |
| Definir los impuestos por defecto de un grupo de productos | Categorías de productos |
| Adjuntar el RUT, una ficha técnica u otro archivo | Archivos adjuntos |
| Ver los campos que mi empresa agregó a los registros | Datos adicionales |
| Ordenar, filtrar, mover columnas, guardar vistas o buscar con el filtro avanzado | Listados |
| Crear un registro parecido a otro (Duplicar) o llenar un formulario con el teclado | Moverse por el sistema |
| Administrar usuarios, permisos, visibilidad de campos o ver la auditoría | Administración de la empresa |
| Llevarme un listado a PDF, Excel o CSV | Exportar un listado |
| Cargar muchos registros desde Excel | Importar datos |
| Reportar un problema o hacer una pregunta | Soporte |

## Si algo no aparece

Cada empresa contrata los módulos que necesita y cada rol tiene sus permisos. Si no ves una opción del menú, un botón (por ejemplo **Nuevo** o **Importar**), una pestaña, un indicador o una tarjeta de Inicio, es porque tu empresa no tiene esa función habilitada o tu rol no la puede usar. Pídele al administrador de tu empresa que revise tus permisos, o abre un ticket en **Soporte**.

## Las tarjetas son enlaces

Cada indicador que tiene un lugar donde trabajar es un **enlace**: **Borradores** abre los comprobantes sin terminar (en **Borrador**, **Grabado** o **No Aprobado**, los mismos que impiden cerrar el período), **Períodos abiertos** los períodos abiertos, **Terceros activos** el listado de terceros, y así los demás. Un clic normal se abre en tu pestaña; **⌘/Ctrl+clic** en otra del navegador. El monto de una tarjeta nunca se parte en dos líneas: si es muy largo, la letra se reduce.
