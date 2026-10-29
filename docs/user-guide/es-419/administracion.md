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
  - kernel.admin.permission.set
  - kernel.admin.permission.matrix
  - kernel.admin.field_permission.set
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
---

# Administración de la empresa

La **Administración** es donde el administrador de la empresa decide quién usa el sistema y qué puede hacer cada persona: roles, usuarios, permisos, visibilidad de campos, procesos sensibles, módulos, archivos obligatorios, datos adicionales, verificadores, el uso de IA y la auditoría.

Solo la ve quien tiene el rol **admin** de la empresa. Ábrela desde el menú **Módulos › Sistema › Administración** (o escribe «administración» en ⌘K). Las secciones están en la barra bajo el título.

## Cada cambio pide tu código

Todos los cambios de administración son **acciones sensibles**: al guardar, el sistema te pide el **código de 6 dígitos** de tu app de autenticación (guía **Ingresar y verificación en dos pasos**). El cursor queda en la caja del código y al sexto dígito se envía solo; **Esc** cancela. Cada código vale para una sola acción, durante 5 minutos, y solo para ti. Todos los cambios quedan en la **auditoría** con quién, cuándo y qué cambió.

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

En **Usuarios** ves a las personas de la empresa con su correo, celular, roles y si ya activaron la verificación en dos pasos (**2FA activo** o **pendiente**).

1. Pulsa **Nuevo usuario**.
2. Escribe el **Nombre completo**, el **Correo** (con él inicia sesión) y el **Celular** con su indicativo (en Colombia, 10 dígitos que empiezan por 3).
3. Marca **al menos un rol**. La **foto** es opcional (PNG, JPEG o WebP de hasta 300 KB).
4. Pulsa **Crear e invitar** e ingresa tu código.

La persona recibe una **invitación por correo**: con el enlace define su contraseña y luego activa la verificación en dos pasos en su perfil.

- Si la persona ya es usuaria de **otra empresa de tu misma organización**, no se le envía otra invitación: se le agrega a esta empresa con los roles elegidos y conserva sus datos (nombre, celular, foto).
- Si el correo ya pertenece a **otra organización**, el sistema no lo agrega y responde «Ese correo ya pertenece a otra organización». Cada cuenta pertenece a una sola organización.

Para cambiar los roles de alguien pulsa **Editar roles** en su fila. Cada usuario conserva siempre al menos un rol, y nadie puede quitarse su propio rol admin. Los cambios de rol aplican la próxima vez que la persona inicia sesión.

## Permisos

**Permisos** es la matriz de procesos por rol: cada fila es un proceso (agrupados por módulo), con su identificador, la acción (crear, actualizar, eliminar, consultar) y debajo la **entidad** sobre la que actúa (Tercero, Producto, Importación…). Cada columna es un rol. La columna del proceso queda fija a la izquierda cuando desplazas los roles hacia los lados, y el resultado de cada cambio («Cambios guardados» o el motivo del rechazo) aparece en la barra fija debajo de la matriz, así la tabla no se mueve mientras marcas casillas. La matriz de **Visibilidad de campos** funciona igual.

Marca la casilla para **permitir** el proceso a ese rol, o desmárcala para **negarlo**, e ingresa tu código. El efecto es inmediato: los menús, los botones, las exportaciones y las herramientas del asistente de quienes tienen ese rol se ajustan. Por ejemplo, al permitir **Importación** (`kernel.import.run`) a un rol, sus usuarios ven **Importar datos** en el menú; al negarlo, desaparece.

La columna del rol **admin** no se edita: el administrador puede ejecutar todos los procesos, también los que lleguen con módulos nuevos. Los procesos de **administración** solo los tiene el rol admin: no se pueden dar a otro rol. Los procesos marcados **2FA** siempre piden la verificación en dos pasos.

## Visibilidad de campos

Elige la **Entidad** (Tercero, Producto…) y, para cada campo y cada rol, si se ve **visible**, **enmascarado** u **oculto**:

- **Enmascarado**: el campo aparece pero sin su valor.
- **Oculto**: el campo no aparece.

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

- **Tokens del mes** con la barra frente al **tope mensual** de la empresa.
- **Costo estimado** en dólares.
- El detalle **por usuario** (llamadas, tokens y costo) y **por modelo**.

Cuando la empresa llega al tope, el asistente responde sin usar el modelo hasta el mes siguiente o hasta que se amplíe el tope. Para ampliarlo, pide el cambio de plan a tu proveedor de ERP-IA.

## Auditoría

La **Auditoría** muestra todo lo que pasó en la empresa: cada creación, cambio, consulta y cada intento denegado, de cualquier persona. Ábrela desde **Módulos › Sistema › Auditoría** o desde la sección **Auditoría** de la Administración. Solo la ve el rol **admin**: para cualquier otra persona la pantalla dice que no tiene permiso, y el asistente tampoco le muestra estos registros.

Cada fila es una entrada, de la más reciente a la más antigua:

- **Fecha**: cuándo ocurrió, en la zona horaria de la empresa.
- **Origen**: desde dónde se hizo. **ui** es la pantalla, **agent** el asistente (después de que la persona confirmó la tarjeta), **scheduler** una tarea programada, **event** una reacción automática a otro cambio, **api** un programa externo o la carga de datos de demostración, y **db** un cambio hecho directamente en la base de datos.
- **Proceso**: la acción del sistema, por ejemplo `core.party.create` (crear un tercero) o `kernel.export.run` (exportar un listado).
- **Entidad** y **Registro**: qué tabla y qué registro cambió (el identificador del registro).
- **Acción**: **Creó**, **Cambió**, **Eliminó**, **Consultó** o **Denegado** (un intento sin permiso o sin el código de verificación).
- **Actor**: el correo de quien lo hizo. Lo que hace el asistente queda a nombre de la persona que lo pidió.
- **Cadena**: el identificador que une todo lo que provocó una misma acción. Filtra por una cadena para ver, por ejemplo, la creación de un tercero y los cambios que desencadenó.

Para encontrar algo:

1. Escribe en el filtro de una columna, por ejemplo `core.party.create` bajo **Proceso**, o elige **agent** en **Origen**.
2. Usa **Filtro avanzado** para combinar condiciones (por ejemplo, un actor **y** un rango de fechas).
3. Pulsa **PDF**, **Excel** o **CSV** para llevarte exactamente las filas filtradas (guía **Exportar un listado a PDF, Excel o CSV**). Guarda la búsqueda con **Guardar vista** si la repites.

La auditoría es de **solo inserción**: nadie, ni siquiera el administrador, puede cambiar ni borrar una entrada, y se conserva 10 años. No muestra los valores que cambiaron: para ver un dato, abre el registro, donde se aplica la visibilidad de campos de tu rol. Consultar la auditoría queda, a su vez, en la auditoría.

## Preguntas frecuentes

**¿Por qué no veo Administración?** Solo la ve quien tiene el rol admin de la empresa.

**Le di un permiso a un rol y la persona no lo ve.** Pídele que recargue la página. Si le asignaste un rol nuevo, debe salir e iniciar sesión de nuevo.

**¿Puedo borrar un rol o un usuario?** En esta versión no: quita los permisos del rol o los roles del usuario.

**¿Puedo borrar o corregir una entrada de la auditoría?** No. La auditoría es de solo inserción para todos; si algo se hizo mal, corrígelo en el registro y la corrección quedará como una entrada nueva.
