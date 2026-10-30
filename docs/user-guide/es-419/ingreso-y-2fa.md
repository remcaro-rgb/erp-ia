---
title: Ingresar y verificación en dos pasos
routes:
  - /login
  - /mfa/verify
  - /mfa/enroll
processes:
  - kernel.user.mfa.disable
---

# Ingresar y verificación en dos pasos

Para entrar a ERP-IA escribes tu correo y tu contraseña. Si tu rol lo exige (o ya activaste la verificación), el sistema te pide además un código de 6 dígitos que genera tu app de autenticación. Esa verificación en dos pasos protege tu cuenta aunque alguien conozca tu contraseña.

## Ingresar

1. Abre la página de ingreso.
2. Escribe tu **Correo** y tu **Contraseña**. El ícono del ojo, a la derecha de la contraseña, la muestra u oculta.
3. Decide si marcas **Recordarme en este dispositivo por 30 días**:
   - **Marcada**: tu sesión dura 30 días en este navegador y el correo aparece escrito la próxima vez que abras la página de ingreso. Úsala solo en tu equipo personal.
   - **Sin marcar**: la sesión termina al cerrar el navegador.
4. Pulsa **Entrar**.

Si tu cuenta tiene verificación en dos pasos, el siguiente paso es el código (ver abajo). Si no, entras directo a **Inicio**.

### Si no puedes entrar

- «Correo o contraseña incorrectos.»: revisa los datos. El sistema no dice cuál de los dos falla.
- «Tu usuario no pertenece a ninguna empresa. Pide acceso al administrador.»: tu cuenta existe pero aún no tiene empresa asignada.
- «Demasiados intentos, espera unos minutos.»: después de 10 intentos fallidos en 5 minutos sobre la misma cuenta, el ingreso se bloquea hasta que pase esa ventana de 5 minutos.
- «No pudimos conectar con el servicio de acceso. Inténtalo de nuevo.»: es un problema temporal del servicio.

## Escribir el código de verificación

Cuando tu cuenta ya tiene la verificación activada, después de la contraseña ves **Verificación en dos pasos**.

1. Abre tu app de autenticación y busca la entrada **ERP-IA**.
2. Escribe los **6 dígitos** que muestra. Al completar el sexto el formulario se envía solo; también puedes pulsar **Verificar**.
3. Entras a **Inicio**.

Si el código no es correcto, ves «El código no es correcto. Revisa tu app e inténtalo de nuevo.» Los códigos cambian cada 30 segundos aproximadamente: espera al siguiente. El botón **Volver** cierra la sesión y te devuelve a la página de ingreso.

## Activar la verificación (primera vez)

Si el administrador exige la verificación en dos pasos a tu rol y aún no la tienes, después de la contraseña ves **Activa la verificación en dos pasos**.

1. Instala una app de autenticación en tu celular (Google Authenticator, Authy o 1Password).
2. En la app, escanea el **código QR** de la pantalla. Si no puedes escanear, escribe la **Clave** que aparece debajo del QR.
3. Escribe el primer código de 6 dígitos que muestra la app.
4. Al verificarlo, la verificación queda activa y entras a **Inicio**.

Guarda bien tu app: desde ahora la necesitarás en cada ingreso. Una cuenta que ya tiene la verificación activada no puede volver a registrar otra app por su cuenta (primero tiene que verificar la que tiene); si perdiste tu celular, pide al administrador de tu empresa que **quite tu segundo paso** (ver «Administración de la empresa»): vuelves a entrar con tu contraseña y registras la app nueva.

### Activarla por tu cuenta

Aunque tu rol no la exija, puedes activar la verificación cuando quieras:

1. Abre el menú de tu usuario (el círculo con tus iniciales, arriba a la derecha) y elige **Verificación en dos pasos**. El cuadro dice **Estado: No configurada**.
2. Pulsa **Activar**. Ves la misma pantalla de activación de arriba: escanea el QR (o escribe la **Clave**) y escribe el primer código.
3. Al verificarlo vuelves a **Inicio**. Desde ese momento cada ingreso te pide el código.

Si cambias de idea antes de escribir el código, pulsa **Omitir por ahora**: vuelves a la aplicación sin activarla. Ese enlace solo aparece cuando tu rol no exige la verificación.

## Desactivar la verificación en dos pasos

Si tu rol no la exige, puedes desactivarla:

1. Abre el menú de tu usuario y elige **Verificación en dos pasos**. El cuadro dice **Estado: Activa**.
2. Pulsa **Desactivar**. Como es una acción sensible, el cuadro te pide un código **nuevo** de tu app: escríbelo (al sexto dígito se envía solo).
3. La verificación queda desactivada y tus sesiones abiertas se cierran, también en otros navegadores o equipos. La página de ingreso te dice «Segundo paso desactivado. Vuelve a ingresar con tu contraseña.»
4. Desde ahora entras solo con tu correo y tu contraseña.

Si tu rol exige la verificación en dos pasos (por ejemplo, el rol admin), el cuadro dice «Tu rol exige la verificación en dos pasos, así que no puedes desactivarla. Si necesitas hacerlo, pídele a un administrador que te exima.» y el botón **Desactivar** aparece apagado. Si un administrador te eximió, el cuadro lo indica y puedes desactivarla como cualquier otra persona.

### Qué pasa con las acciones sensibles

Sin la verificación en dos pasos no puedes confirmar acciones sensibles (las de administración, importar datos y las que el administrador marque): no tienes de dónde sacar el código. Si intentas una, aparece el cuadro **Verificación requerida**; al enviar un código, el cuadro te dice «Activa la verificación en dos pasos en tu menú de usuario para ejecutar esta acción.» con el enlace **Activarla ahora**, que te lleva a la pantalla de activación. **Cancelar** (o **Esc**) cierra el cuadro sin hacer la acción. Cuando la activas de nuevo, las acciones sensibles vuelven a funcionar con tu código.

## Confirmar una acción sensible

Algunas acciones son sensibles y piden un código **nuevo** aunque ya hayas ingresado con tu código. Por defecto lo son las acciones de administración: **definir o quitar un dato adicional** de una entidad y **importar datos** desde Excel o CSV. El administrador de tu empresa puede marcar otros procesos como sensibles.

Cuando ocurre, aparece un cuadro **Verificación requerida** con el mensaje «Esta acción es sensible. Ingresa el código de 6 dígitos de tu app de autenticación.»

1. El cursor ya está en la caja: escribe (o pega) el código de 6 dígitos de tu app.
2. Al completar el sexto dígito el código se envía solo (también puedes pulsar **Verificar** o Enter). La acción continúa sola, con los mismos datos que ya habías llenado. Si el código no sirve, la caja se vacía y queda lista para el siguiente. **Esc** (o **Cancelar**) cierra el cuadro sin hacer la acción.
3. Si prefieres no seguir, pulsa **Cancelar**: no se guarda nada.

Detalles que conviene conocer:

- La verificación vale **5 minutos** y se usa **una sola vez**: la acción que la consume queda confirmada; la siguiente acción sensible pide un código nuevo.
- La verificación queda ligada a tu usuario y a la empresa en la que estás trabajando; nadie más puede usarla.
- Si el código no es válido ves «El código no es válido. Inténtalo de nuevo.». También hay un límite de intentos por usuario (10 en 5 minutos).
- Para confirmar una acción sensible necesitas tener la verificación en dos pasos activada (ver «Qué pasa con las acciones sensibles»).

## Salir

Abre el menú de tu usuario (el círculo con tus iniciales, arriba a la derecha) y elige **Salir**.
