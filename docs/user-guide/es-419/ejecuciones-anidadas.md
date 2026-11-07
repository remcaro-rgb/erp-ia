---
title: "Ejecuciones anidadas: cuándo un proceso corre otro, qué pasa si falla y la cola de fallos"
routes:
  - /admin/nested-runs
  - /nested-failures
processes:
  - kernel.admin.nested_run.pair.set
  - kernel.admin.nested_run.depth.set
  - kernel.nested_failure.retry
  - kernel.nested_failure.dismiss
---

# Ejecuciones anidadas: cuándo un proceso corre otro, qué pasa si falla y la cola de fallos

Algunas operaciones del sistema se componen de otras. Por ejemplo, **convertir un prospecto en cliente** (CRM) corre por dentro la **creación del tercero**; **anular una factura** corre por dentro la **nota crédito de anulación**. Al proceso que manda se le llama **padre** y al que corre por dentro, **anidado**. Los dos van en una misma operación: o salen los dos o no sale ninguno.

El administrador de la empresa decide tres cosas sobre estas ejecuciones, en **Sistema › Administración › Ejecuciones anidadas** (la sección está junto a Permisos). Cada cambio de esa pantalla pide el **código de 6 dígitos** de tu verificación en dos pasos (guía [Ingresar y verificación en dos pasos](ingreso-y-2fa.md)), también cuando solo restringes algo.

## Valores de fábrica

Mientras no configures nada, el sistema se comporta así:

- Se permiten **4 niveles** de procesos anidados uno dentro de otro.
- Un proceso anidado que exige verificación en dos pasos **no corre** dentro de otro: se rechaza.
- Si el proceso anidado falla, **se revierte todo**, también lo que ya había hecho el padre.

## 1. Niveles permitidos

En la parte de arriba de la pantalla, el campo **Niveles permitidos** acepta un número de **1 a 8**. Es el máximo de procesos que pueden quedar uno dentro de otro. Si un proceso intenta pasar de ese número, la operación se rechaza y se revierte. Escribe el número y pulsa **Guardar niveles**.

## 2. Pares: la TOTP del padre cubre

Un **par** es un proceso padre junto con el proceso anidado que corre por dentro. Para agregar uno, usa el formulario **Agregar un par**: eliges de las listas el **proceso anidado** y el **proceso padre** (las listas salen del registro de procesos, por eso no se puede escribir uno que no existe). Si el proceso anidado solo corre dentro de ciertos padres, la lista de padres ofrece solo esos y la pantalla lo avisa.

Un par que ningún proceso corre no hace nada: los pares no se descubren solos, los armas tú por nombre.

La opción **La TOTP del padre cubre** sirve para esto: cuando el padre pide el código de 6 dígitos y el proceso anidado también lo pediría, el mismo código que acabas de dar para el padre vale para el anidado y no te lo piden otra vez. Hay límites que no se pueden mover:

- Solo vale el código recién verificado, **de la misma persona** y de **menos de 5 minutos**, usado en esa misma operación. Un código viejo, de otra persona o ya usado en otra operación no cubre nada.
- Solo cubre a los procesos anidados de los pares que tú prendiste.
- El padre tiene que pedir el código él mismo. Si no lo pide, la opción no hace nada y la pantalla te lo dice junto al par.
- El permiso del proceso anidado se sigue revisando: quien no tiene permiso para el proceso anidado no lo corre, aunque el padre sí corra.

## 3. En caso de fallo: «Revertir todo» o «Continuar y encolar»

Cada par tiene la opción **En caso de fallo**:

- **Revertir todo** (la de fábrica): si el proceso anidado falla, no queda nada guardado de la operación completa. La persona ve el motivo y vuelve a intentar.
- **Continuar y encolar**: si el proceso anidado falla por un problema de datos, **solo se deshace lo que ese proceso anidado alcanzó a hacer**; el padre termina y guarda su trabajo, y el fallo queda en la **cola de fallos** (más abajo) para reintentarlo o descartarlo. Es útil cuando lo anidado es un complemento y no debe frenar el trabajo principal.

«Continuar y encolar» solo atiende fallos de **datos** (datos no válidos, un registro que no existe, un error del proceso). Un problema de **permisos** (no tienes permiso, falta tu verificación en dos pasos, el módulo no está activo) nunca se encola: siempre se revierte todo, porque no es algo que se arregle reintentando.

### Por qué lo que contabiliza o mueve existencias nunca continúa

Verás la etiqueta **Contabiliza o mueve existencias** junto a los procesos anidados que dejan un asiento contable o mueven inventario (por ejemplo, la nota crédito de una anulación). En esos casos **«Continuar y encolar» está desactivado**: si fallan, siempre se revierte todo. La razón es que dejar a medias un asiento o un movimiento de existencias deja los libros y el inventario sin cuadrar. El sistema lo decide solo, a partir de lo que cada proceso declara; si dudas, la etiqueta marca de más a propósito.

Si un par ya estaba guardado como «Continuar y encolar» y luego el proceso pasó a contabilizar o mover existencias, el sistema también lo trata como «Revertir todo» al ejecutarlo.

## La cola de fallos

La pantalla **Fallos de ejecuciones anidadas** (Sistema › Fallos de ejecuciones anidadas, y el enlace **Ver la cola de fallos** de la pantalla de configuración) lista cada fallo que quedó encolado:

- **Proceso padre** y **proceso anidado**, con su nombre y su identificador.
- **Motivo**: el texto que explica el problema, por ejemplo «El número de documento no es válido».
- **Quién** corrió la operación, **cuándo** y el **estado**: **Pendiente**, **Resuelto** o **Descartado**, con el número de **intentos**.

La pantalla **no muestra los datos originales** de la operación (están guardados solo para poder reintentar, y quedan ocultos igual que un campo confidencial). Con **Solo pendientes** ocultas los que ya se cerraron.

### Reintentar y Descartar

- **Reintentar** corre otra vez el proceso anidado con los mismos datos. Pide tu **código de 6 dígitos**, porque vuelve a escribir datos. Corre **como tú**, con tus permisos (no como la persona que lo causó) y, si vuelve a fallar, ves el motivo y el fallo **sigue pendiente**; si sale bien, queda **Resuelto**. Si el fallo ya estaba resuelto o descartado, el sistema dice que no existe.
- **Descartar** cierra el fallo sin reintentarlo. La fila no se borra: queda como **Descartado**.

Cada reintento y cada descarte quedan en la **auditoría** con quién y cuándo, y los reintentos señalan el fallo original.

### Quién la ve

La cola es para el **administrador de la empresa** y para los **roles a los que el administrador les dio el permiso «Reintentar una ejecución anidada fallida»** en Permisos. Quien no tiene ese permiso ve una tarjeta de «Sin acceso». Descartar es otro permiso («Descartar una ejecución anidada fallida»): sin él, el botón no aparece. El menú muestra la opción solo a quien puede abrirla. La **configuración** (niveles y pares) es solo del administrador.

### Cuánto se guarda

Los fallos **Resueltos** o **Descartados** se borran solos a los **90 días**. Los **Pendientes** se conservan hasta que los resuelvas o los descartes.

## El asistente no toca esta configuración

El asistente de la plataforma **no puede** cambiar los niveles ni los pares, ni reintentar o descartar un fallo de la cola. Todo esto se hace desde estas pantallas, con tu código de verificación.

## Preguntas frecuentes

**¿Cambiar un par afecta lo que ya pasó?** No. Cambia lo que ocurre de ahí en adelante.

**Puse «Continuar y encolar» y la factura salió igual aunque algo falló. ¿Se perdió algo?** No: lo que falló quedó en la cola con su motivo. Revísala, corrige la causa y pulsa Reintentar.

**No me deja marcar «Continuar y encolar».** Seguramente el proceso anidado contabiliza o mueve existencias (etiqueta amarilla): ahí siempre se revierte todo.
