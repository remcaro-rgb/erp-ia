---
title: Administración de la empresa
routes:
  - /admin/permissions
  - /admin/roles
  - /admin/users
  - /admin/fields
  - /admin/extra
  - /admin/required-files
  - /admin/sensitive
  - /admin/verifiers
  - /admin/modules
  - /admin/companies
  - /admin/ai-usage
  - /admin/audit
processes:
  - kernel.admin.role.create
  - kernel.admin.role.update
  - kernel.admin.user_role.set
  - kernel.admin.user.create
  - kernel.admin.user.update
  - kernel.admin.user.mfa.set
  - kernel.admin.permission.set
  - kernel.admin.permission.set_many
  - kernel.admin.permission.matrix
  - kernel.admin.field_permission.set
  - kernel.admin.field_permission.set_many
  - kernel.admin.sensitive_process.set
  - kernel.admin.module.enable
  - kernel.admin.module.disable
  - kernel.admin.company.update
  - kernel.admin.ai_usage.consult
  - kernel.required_file.set
  - kernel.required_file.remove
  - kernel.verifier.set
  - kernel.custom_field.set
  - kernel.custom_field.remove
  - kernel.audit.consult
  - kernel.audit.entry
---

# Administración de la empresa

La **Administración** es donde el administrador de la empresa decide quién usa el sistema y qué puede hacer cada persona: roles, usuarios, permisos, visibilidad de campos, procesos sensibles, módulos, archivos obligatorios, datos adicionales, verificadores, el uso de IA y la auditoría.

Solo la ve quien tiene el rol **admin** de la empresa. Ábrela desde el menú **Módulos › Sistema › Administración** (o escribe «administración» en ⌘K). Las secciones están en la barra bajo el título.

## Cada cambio pide tu código

Todos los cambios de administración son **acciones sensibles**: al guardar, el sistema te pide el **código de 6 dígitos** de tu app de autenticación (guía **Ingresar y verificación en dos pasos**). El cursor queda en la caja del código y al sexto dígito se envía solo; **Esc** cancela. Cada código vale para una sola acción, durante 5 minutos, y solo para ti. Todos los cambios quedan en la **auditoría** con quién, cuándo y qué cambió.

En las matrices de **Permisos** y **Visibilidad de campos** los cambios se acumulan y se aplican juntos: un solo código para todas las casillas que marcaste (ver abajo).

Consultar las pantallas no pide código: solo cambiar. Tampoco lo piden la matriz de permisos ni el informe de uso de IA cuando se los pides al asistente.

## Roles

En **Roles** ves los roles de la empresa con su descripción, qué terceros ven, cuántos permisos tienen y qué usuarios los tienen.

1. Pulsa **Nuevo rol**, escribe el **Nombre** y la **Descripción** y elige qué terceros ve en **Ve terceros**:
   - **Clientes y proveedores**: todos los terceros.
   - **Solo clientes** o **Solo proveedores**: los listados, formularios, exportaciones, búsquedas y el asistente muestran solo esos.
   - **No ve terceros**: ninguno.
2. Pulsa **Crear rol** e ingresa tu código.

Un rol nuevo empieza con lo básico: puede **consultar** los registros de los módulos activos, usar la ayuda y el asistente, guardar vistas y exportar lo que ve. Sus **campos confidenciales** (por ejemplo el cupo de crédito, el saldo o el costo estándar) empiezan **enmascarados**. Luego ajusta sus permisos en **Permisos** y su visibilidad en **Visibilidad de campos**.

Para asignar personas a un rol, pulsa **Editar y asignar**, marca los usuarios y pulsa **Guardar**. También puedes cambiar ahí el nombre, la descripción o el alcance de terceros. El rol **admin** del sistema conserva su nombre y ve todos los terceros.

## Usuarios

En **Usuarios** ves a las personas de la empresa con su correo, celular, roles y si ya activaron la verificación en dos pasos (**2FA activo** o **pendiente**; **exenta** si la eximiste del segundo paso y no lo tiene activo, ver «Quitar o eximir el segundo paso de un usuario»).

1. Pulsa **Nuevo usuario**.
2. Escribe el **Nombre completo**, el **Correo** (con él inicia sesión) y el **Celular** con su indicativo (en Colombia, 10 dígitos que empiezan por 3).
3. Marca **al menos un rol**. La **foto** es opcional (PNG, JPEG o WebP de hasta 300 KB).
4. Pulsa **Crear e invitar** e ingresa tu código.

La persona recibe una **invitación por correo**: con el enlace define su contraseña y luego activa la verificación en dos pasos en su perfil.

- Si la persona ya es usuaria de **otra empresa de tu misma organización**, no se le envía otra invitación: se le agrega a esta empresa con los roles elegidos y conserva sus datos (nombre, celular, foto).
- Si el correo ya pertenece a **otra organización**, el sistema no lo agrega y responde «Ese correo ya pertenece a otra organización». Cada cuenta pertenece a una sola organización.

En la lista, el nombre de cada persona abre su **página de usuario**, y la columna **Estado** dice si está **Activo** o **Inactivo**.

## Usuarios: editar y desactivar

### La página de un usuario

Ábrela con el nombre de la persona en **Usuarios**, o con cualquier enlace a ella: el **Actor** de la auditoría, quien reportó un ticket. Muestra:

- **Datos**: nombre, correo (con él inicia sesión), celular e idioma, con su foto arriba.
- **Acceso**: sus **roles** (cada uno con enlace a **Roles**), si tiene la **verificación en dos pasos** (**Activa** o **No configurada**), su **estado** y su **última actividad**: la fecha y hora de lo último que hizo en la empresa según la auditoría (por ejemplo, su último inicio de sesión). Si nunca hizo nada, dice «Sin actividad registrada».

Solo el administrador ve estas páginas.

### Editar

1. Pulsa **Editar** en la página del usuario, o en su fila de **Usuarios**.
2. Cambia lo que necesites: **Nombre completo**, **Celular** (con su indicativo), **Idioma**, **Foto** (o **Quitar la foto**) y los **roles** (al menos uno). El correo no se cambia: es con lo que la persona inicia sesión.
3. Pulsa **Guardar** e ingresa tu código.

Solo se guarda lo que cambiaste, y la auditoría registra cada dato con su valor anterior y el nuevo (la foto aparece como «(foto)», nunca la imagen). Mientras no cambies nada, **Guardar** sigue apagado. Cada usuario conserva siempre al menos un rol, y nadie puede quitarse su propio rol admin. Los datos cambian de inmediato; un rol nuevo aplica la próxima vez que la persona inicia sesión, y uno que le quitas deja de valer al momento.

### Desactivar y reactivar

Cuando una persona deja la empresa, o no debe entrar por un tiempo, **desactívala**:

1. En su página pulsa **Desactivar**.
2. Confirma en «¿Desactivar a …?» con **Desactivar** e ingresa tu código.

Desde ese momento la persona **no puede iniciar sesión** («Cuenta desactivada. Contacta a un administrador.»). Si tenía una sesión abierta, el sistema le niega todo al instante: no puede guardar ni ejecutar ningún proceso, abrir pantallas ni usar el asistente. Lo que una pestaña que ya tenía abierta le pida al servidor (por ejemplo, la página siguiente de un listado) se rechaza, y en cuanto cambia de pantalla, recarga o le escribe al asistente, el sistema cierra su sesión con el mismo aviso. Si la persona trabaja también en otra empresa donde sigue activa, en vez de cerrar su sesión el sistema la pasa a esa empresa. No se borra nada: conserva sus roles, su nombre sigue en los registros y en la auditoría, y su página la muestra **Inactivo**.

Para devolverle el acceso, pulsa **Reactivar** en su página, confirma e ingresa tu código: vuelve a entrar con los mismos roles que tenía.

- **No puedes desactivar tu propia cuenta**: el botón aparece apagado en tu página.
- La empresa necesita **al menos un administrador activo**: no se puede desactivar al último que tiene el rol admin.

### Quitar o eximir el segundo paso de un usuario

En la página del usuario, la fila **Verificación en dos pasos** tiene dos acciones. Las dos piden tu código y quedan en la auditoría con tu nombre y el de la persona.

**Quitar segundo paso** aparece cuando la persona tiene la verificación **Activa**. Úsalo cuando perdió su celular o cambió de app:

1. Pulsa **Quitar segundo paso**.
2. Confirma en «¿Quitar el segundo paso de …?» con **Quitar segundo paso** e ingresa tu código.
3. La fila pasa a **No configurada**. Las sesiones abiertas de esa persona se cierran; la tuya sigue.

En su próximo ingreso la persona entra con su contraseña. Si su rol exige la verificación (el rol admin, sin exención), el sistema le pide activarla de nuevo antes de dejarla entrar; si no, entra directo y puede activarla cuando quiera desde su menú de usuario. Si quitas tu propio segundo paso, tu sesión también se cierra y vuelves a ingresar.

El segundo paso es de la **cuenta** de la persona, no de una empresa:

- Si la persona es también administradora de **otra empresa de tu organización**, al quitárselo aquí lo pierde también allá, y el sistema le pide activarlo de nuevo cuando ingresa a esa empresa.
- Si la persona pertenece también a **otra organización**, el sistema no lo quita y responde «Ese usuario pertenece también a otra organización; su segundo paso no se cambia desde aquí». Sí puedes eximirla del segundo paso en tu empresa.

**Exento del segundo paso** es un interruptor que aparece solo para quienes tienen el rol **admin**, porque ese rol exige la verificación en dos pasos:

1. Pulsa el interruptor **Exento del segundo paso** e ingresa tu código.
2. Junto al estado aparece **exenta**; en la lista de **Usuarios**, una persona exenta sin segundo paso dice **exenta** en vez de **pendiente**.

Una persona exenta entra solo con su contraseña si no tiene la verificación activa, y puede desactivarla desde su menú de usuario. Si ya la tiene activa, se la sigue pidiendo hasta que la desactive. Para quitar la exención, vuelve a pulsar el interruptor e ingresa tu código: su próximo ingreso le exigirá la verificación otra vez. Puedes eximirte a ti mismo.

La exención queda guardada en la persona, dentro de esta empresa, **hasta que un administrador la quite** con el interruptor; cambiarle los roles no la borra. Mientras la tenga, su página muestra **exenta** junto al estado. Si le quitas el rol admin, el interruptor deja de aparecer pero la exención sigue (su página sigue diciendo **exenta**), y vuelve a valer si más adelante le das otra vez el rol admin. Para quitarla, apágala antes de quitarle el rol, o devuélvele el rol admin y apágala entonces.

Estas dos acciones no están en el asistente: se hacen solo desde la página del usuario.

Ojo: quien no tiene la verificación activa no puede confirmar **acciones sensibles** (como las de esta sección de administración). Un administrador exento sin segundo paso tendrá que activarlo para volver a administrar.

## Permisos

**Permisos** es la matriz de procesos por rol: cada fila es un proceso (agrupados por módulo), con su identificador, la acción (crear, actualizar, eliminar, consultar) y debajo la **entidad** sobre la que actúa (Tercero, Producto, Importación…). Cada columna es un rol. La columna del proceso queda fija a la izquierda cuando desplazas los roles hacia los lados, y toda la celda sirve para marcar la casilla.

Marca la casilla para **permitir** el proceso a ese rol, o desmárcala para **negarlo**. Con el teclado, ve a la casilla con **Tab** y pulsa **Espacio**. Los cambios no se guardan uno por uno: cada casilla cambiada queda **pendiente** (con un borde de color) y la barra fija debajo de la matriz cuenta cuántos hay, por ejemplo «3 cambios sin aplicar». Si vuelves a dejar una casilla como estaba, deja de contar.

Para un rol nuevo, usa **todos** en la fila de un módulo: marca de una vez todos los procesos de ese módulo para ese rol (menos los de administración, que son solo del rol admin). Si el rol ya los tiene todos, el mismo botón dice **ninguno** y los quita.

Cuando termines:

1. Pulsa **Aplicar cambios** e ingresa tu código. Todos los cambios se aplican juntos, con **un solo código**, y quedan en la auditoría como una sola acción con la lista de cambios (`kernel.admin.permission.set_many`).
2. O pulsa **Descartar** para dejar la matriz como estaba.

Si algún cambio no se puede aplicar (por ejemplo, porque otro administrador quitó ese rol mientras tanto), **no se aplica ninguno**: la casilla con el problema queda marcada en rojo, la barra dice cuántos cambios se rechazaron y por qué, y los demás cambios siguen pendientes. Corrige esa casilla y vuelve a pulsar **Aplicar cambios**. Si sales de la pantalla con cambios pendientes (con un enlace, el menú, las pestañas o el botón **Atrás** del navegador), el sistema te pregunta si quieres **Seguir editando** o **Salir sin aplicar**; al recargar o cerrar la pestaña pregunta el navegador.

El efecto es inmediato: los menús, los botones, las exportaciones y las herramientas del asistente de quienes tienen ese rol se ajustan. Por ejemplo, al permitir **Importación** (`kernel.import.run`) a un rol, sus usuarios ven **Importar datos** en el menú; al negarlo, desaparece.

La columna del rol **admin** no se edita: el administrador puede ejecutar todos los procesos, también los que lleguen con módulos nuevos. Los procesos de **administración** solo los tiene el rol admin: sus casillas están bloqueadas en los demás roles. Los procesos marcados **2FA** siempre piden la verificación en dos pasos.

El asistente también puede cambiar un permiso o la visibilidad de un campo, de a uno, con tu confirmación y tu código.

## Visibilidad de campos

Elige la **Entidad** (Tercero, Producto…) y, para cada campo y cada rol, si se ve **visible**, **enmascarado** u **oculto**:

- **Enmascarado**: el campo aparece pero sin su valor.
- **Oculto**: el campo no aparece.

Como en **Permisos**, cada cambio queda pendiente hasta que pulsas **Aplicar cambios** e ingresas tu código: puedes cambiar campos de varias entidades y aplicarlos todos juntos (`kernel.admin.field_permission.set_many`), o **Descartar**. Si se rechaza un cambio de una entidad que no estás viendo, la barra dice en cuál está.

Aplica igual en los listados, los formularios, las exportaciones y las respuestas del asistente. Un campo enmascarado u oculto no se puede usar para ordenar ni filtrar. Los campos marcados **confidencial** empiezan enmascarados en cada rol nuevo y en los roles que ya existían cuando el campo apareció. El rol admin ve todos los campos, aunque tenga además otro rol que los enmascare.

Con varios roles, en la visibilidad de un campo gana el modo más restrictivo (oculto antes que enmascarado, enmascarado antes que visible), mientras que los permisos de procesos se suman: darle a alguien un rol más puede ocultarle un campo que antes veía.

## Procesos sensibles

Activa el interruptor de un proceso para que pida la **verificación en dos pasos** cada vez que alguien lo ejecute en esta empresa (por ejemplo, desactivar un tercero o un producto). Los procesos de administración que cambian algo siempre la piden y no se pueden apagar; las consultas de administración (matriz de permisos, uso de IA) no la piden.

## Módulos

Cada tarjeta muestra un módulo, si está **activo**, su menú, de qué módulos **depende** y cuáles **lo necesitan**. Con el interruptor lo activas o desactivas (ingresa tu código).

- Un módulo desactivado desaparece del menú, de las exportaciones y de las herramientas del asistente. **Sus datos se conservan** y vuelven al activarlo.
- No puedes desactivar un módulo del que depende otro activo: por ejemplo, **Núcleo** no se apaga mientras **Soporte** esté activo. Desactiva primero el que depende.
- Solo se activan los módulos que tu empresa tiene **contratados**.
- Al activar un módulo, todos los roles reciben permiso de **consultar** sus registros; los demás permisos se dan en **Permisos**.

## Archivos obligatorios

Para cada entidad defines los archivos que sus registros deben tener: la **etiqueta** (por ejemplo «RUT»), el **tipo** (PDF, imagen o cualquiera), si es **obligatorio** y **cuándo aplica** (siempre, tercero de Colombia, persona jurídica de Colombia, proveedor o cliente). Pulsa **Guardar** en la fila e ingresa tu código. Cada etiqueta se usa una sola vez por entidad (sin importar mayúsculas ni espacios).

Un registro al que le falta un archivo obligatorio queda como **no facturable** hasta que lo cargues con esa etiqueta y ese tipo (guía **Archivos adjuntos**). El cambio aplica de inmediato a los registros que ya existen. **Quitar** deja de exigir el archivo; los archivos ya cargados se conservan.

## Datos adicionales

Por entidad, defines campos propios de la empresa con su tipo, longitud, si son obligatorios y qué roles pueden ingresarlos, editarlos y verlos. Pulsa **Nuevo dato** o **Editar**, completa el formulario y guarda con tu código. Los detalles están en la guía **Datos adicionales**.

## Verificadores

Para cada tipo de dato (correo, teléfono, número de identificación) eliges el **proveedor** de verificación externa entre los **conectados** a ERP-IA (los demás candidatos aparecen como referencia). Mientras no haya proveedor, el botón **Verificar** de los formularios deja las solicitudes **en cola**.

## Empresa

Cambia la **razón social**, el **nombre comercial** y la **zona horaria** de la empresa activa. La zona horaria rige los reportes, la programación y el mes del uso de IA. El NIT, el país y la moneda definen el paquete fiscal y no se cambian aquí.

## Uso de IA

Muestra, para el mes elegido (en la zona horaria de la empresa):

- **Tokens del mes** con una barra frente al **tope mensual** de la empresa: dos marcas señalan el 80 % (aviso) y el 100 % (tope), y el porcentaje está escrito al lado. Al llegar al tope la barra se pone roja y el texto dice «límite alcanzado: el asistente solo responde consultas».
- **Costo estimado** en dólares.
- El detalle **por usuario** (llamadas, tokens y costo) y **por modelo**.

Cuando la empresa llega al tope, el asistente responde sin usar el modelo hasta el mes siguiente o hasta que se amplíe el tope. Para ampliarlo, pide el cambio de plan a tu proveedor de ERP-IA.

## Auditoría

La **Auditoría** muestra todo lo que pasó en la empresa: cada creación, cambio, consulta y cada intento denegado, de cualquier persona. Ábrela desde **Módulos › Sistema › Auditoría** o desde la sección **Auditoría** de la Administración. Solo la ve el rol **admin**: para cualquier otra persona la pantalla dice que no tiene permiso, y el asistente tampoco le muestra estos registros.

Cada fila es una entrada, de la más reciente a la más antigua:

- **Fecha**: cuándo ocurrió, en la zona horaria de la empresa.
- **Origen**: desde dónde se hizo. **ui** es la pantalla, **agent** el asistente (después de que la persona confirmó la tarjeta), **scheduler** una tarea programada, **event** una reacción automática a otro cambio, **api** un programa externo o la carga de datos de demostración, y **db** un cambio hecho directamente en la base de datos. Si el registro se creó con **Duplicar**, al lado dice **clonado desde** y el registro de origen, con enlace.
- **Proceso**: la acción del sistema con su descripción, por ejemplo «Crea un tercero (cliente, proveedor o empleado) con sus datos fiscales DIAN», y debajo su identificador (`core.party.create`). Pasa el puntero por la descripción para leerla completa.
- **Entidad**: el nombre de lo que cambió (**Tercero**, **Producto**, **Categoría de producto**…). Las tablas internas del sistema, que no tienen nombre, se muestran con su identificador.
- **Registro**: el nombre del registro, con enlace a su ficha. Si no tienes acceso a ese registro, o no tiene ficha, se ve su identificador corto.
- **Acción**: **Creó**, **Cambió**, **Eliminó**, **Consultó** o **Denegado** (un intento sin permiso o sin el código de verificación).
- **Actor**: el nombre de quien lo hizo, con enlace a su página de usuario, y su correo debajo. Lo que hace el asistente queda a nombre de la persona que lo pidió; lo que hace el sistema por su cuenta dice **sistema**.
- **Cadena**: el identificador que une todo lo que provocó una misma acción. Filtra por una cadena para ver, por ejemplo, la creación de un tercero y los cambios que desencadenó.

### Ver qué cambió

Haz clic en una fila (o selecciónala con las flechas y pulsa **Enter**) para abrir su detalle a la derecha. Arriba están la descripción del proceso, cuándo, qué acción y desde dónde; luego el proceso, la entidad, el registro, el registro de origen si fue un duplicado, el actor y la cadena, con sus enlaces.

En **Cambios** aparece cada campo que cambió, con su nombre y su valor anterior y el nuevo, así:

> Nombre comercial · — → Bosque QA

El guion (**—**) significa que el campo estaba vacío. Los valores se leen como en los formularios: el tipo de tercero dice **Cliente**, el tipo de documento **31 · NIT**, el municipio **Bogotá D.C.**, el dinero **$ 1.500.000,00** y las fechas van en la zona horaria de la empresa. Si abres la fila del proceso o la del cambio del registro, ves los mismos cambios.

En una creación o en un intento denegado aparece también **Datos recibidos**: lo que se envió al crear el registro, o el motivo del rechazo (por ejemplo «No tienes permiso para hacer esto.») y el proceso que se intentó.

Las entradas de tablas internas del sistema (por ejemplo, las tarjetas de confirmación del asistente) dicen **Sin detalle de campos**: no tienen un catálogo de campos ni reglas de visibilidad, así que el detalle no muestra sus valores. Los códigos de acceso, claves y contraseñas nunca quedan en la auditoría.

Los valores respetan la visibilidad de campos de quien consulta: un campo enmascarado para su rol se ve como **••••••** antes y después, y un campo oculto no aparece. Pulsa **Esc** o **✕** para cerrar el detalle.

### Buscar y exportar

1. Escribe en el filtro de una columna, por ejemplo `core.party.create` bajo **Proceso**, o elige **agent** en **Origen**.
2. Usa **Filtro avanzado** para combinar condiciones (por ejemplo, un actor **y** un rango de fechas).
3. Pulsa **PDF**, **Excel** o **CSV** para llevarte exactamente las filas filtradas (guía **Exportar un listado a PDF, Excel o CSV**). Guarda la búsqueda con **Guardar vista** si la repites.

La exportación lleva las columnas visibles con sus identificadores, sin los valores anteriores y nuevos de cada campo: esos solo se ven en el detalle, con la visibilidad de campos aplicada.

La auditoría es de **solo inserción**: nadie, ni siquiera el administrador, puede cambiar ni borrar una entrada, y se conserva 10 años. Consultar la auditoría o abrir el detalle de una entrada queda, a su vez, en la auditoría.

## Preguntas frecuentes

**¿Por qué no veo Administración?** Solo la ve quien tiene el rol admin de la empresa.

**Marqué varias casillas y no pasó nada.** Los cambios de las matrices quedan pendientes hasta que pulsas **Aplicar cambios** en la barra de abajo e ingresas tu código.

**Le di un permiso a un rol y la persona no lo ve.** Pídele que recargue la página. Si le asignaste un rol nuevo, debe salir e iniciar sesión de nuevo.

**¿Puedo borrar un rol o un usuario?** En esta versión no. A un usuario lo **desactivas** (pierde el acceso y conserva su historial); a un rol le quitas sus permisos.

**¿Puedo borrar o corregir una entrada de la auditoría?** No. La auditoría es de solo inserción para todos; si algo se hizo mal, corrígelo en el registro y la corrección quedará como una entrada nueva.
