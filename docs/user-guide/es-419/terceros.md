---
title: "Terceros: clientes, proveedores y empleados"
routes:
  - /parties
processes:
  - core.party.create
  - core.party.update
  - core.party.deactivate
  - core.party.consult
  - core.party.save
  - core.party.submit
  - core.party.approve
  - core.party.reject
  - core.party.delete
---

# Terceros: clientes, proveedores y empleados

**Terceros** es el maestro de las personas y empresas con las que trabajas. Cada tercero lleva los datos que pide la DIAN para la facturación electrónica y la información exógena, de modo que se pueda usar en una factura sin sorpresas.

Entra desde el módulo **Núcleo › Maestros › Terceros**, o con **⌘K** escribiendo «terc».

## El listado

El listado de Terceros trae, al comienzo, las columnas ID, Tipo de documento, Número de documento, Razón social, Nombre comercial, Tipo de tercero, Municipio, Correo de facturación, Teléfono, Cupo de crédito, Saldo, Estado DIAN, Listo para facturar y Activo. En **Columnas** puedes mostrar otras (departamento, responsabilidades fiscales, CIIU…).

Como en todos los listados, puedes ordenar, filtrar, paginar, guardar vistas, exportar e importar: la guía **Listados** explica cómo. Lo propio de Terceros:

- **Mostrar clientes / Mostrar proveedores**: dos interruptores junto al título. Con los dos activos ves todos; con uno solo, los terceros de esa clase (un tercero que es cliente y proveedor aparece en ambos); con los dos apagados, ninguno.
- Si tu rol solo ve una clase, ves una etiqueta como «tu rol ve solo clientes» y solo el interruptor que corresponde. Esa restricción la define el administrador en el rol (clientes, proveedores, ambos o ninguno) y se aplica también al exportar y al buscar.
- **Estado DIAN** muestra **Completo**, **Faltan N** (faltan N datos para facturar) o **Con errores**.
- **Listo para facturar** es **Sí** solo si el tercero cumple todo lo que se pide para usarlo en una factura (ver abajo).

Haz clic en una fila para abrir el tercero en su propia pestaña.

## Crear un tercero

1. Pulsa **Nuevo** en el listado (o **⌘K** y escribe «crear tercero»). Se abre una pestaña **Crear tercero**.
2. En **Identificación** elige el **Tipo de persona** (**Jurídica y asimiladas** o **Natural y asimiladas**), el **Tipo de documento** (NIT, cédula de ciudadanía… la lista cambia según el tipo de persona y el país) y escribe el **Número** sin puntos ni guiones. Para el NIT, el **DV** (dígito de verificación) se calcula solo con el algoritmo de la DIAN. El número solo admite los caracteres y la longitud de su tipo de documento.
3. En **Nombre**: una persona jurídica lleva **Razón social** (como en el RUT) y, si quieres, **Nombre comercial**. Una persona natural lleva **Primer apellido**, **Segundo apellido**, **Primer nombre** y **Otros nombres**; el **Nombre para documentos** se arma solo con apellidos y nombres, como lo pide la exógena.
4. En **Responsabilidad fiscal** marca las **Responsabilidades** del RUT (casilla 53), elige el **Tributo** y, si lo tienes, la **Actividad económica CIIU** (4 dígitos). El **Resumen RUT** de la derecha te muestra cómo quedará. «No responsable» (R-99-PN) excluye a las demás responsabilidades.
5. En **Ubicación** elige el **País**. Para Colombia aparecen **Departamento**, **Municipio** (códigos DANE; los municipios dependen del departamento) y **Código postal** (6 dígitos, opcional). Si el tercero es del exterior no hay códigos DANE. Escribe la **Dirección** como está en el RUT.
6. En **Comercial** elige la **Relación**: **Cliente**, **Proveedor** o **Cliente y proveedor**. Puedes indicar el **Cupo de crédito**, ver el **Saldo** y escribir una **Persona de contacto**.
7. En **Correos y teléfono para documentos electrónicos** (ver más abajo) escribe el correo que corresponda y el teléfono.
8. Mira el cuadro de estado DIAN al pie del formulario y pulsa **Crear**. También puedes guardar con el teclado desde cualquier campo: **Ctrl+S** o **Ctrl+Enter** (en Mac, **⌘S** o **⌘Enter**); **Enter** no guarda: pasa al campo siguiente (**Mayús+Enter** vuelve al anterior). Si el sistema rechaza el guardado, el cursor salta al primer campo con error, o al cuadro que explica el motivo.

El interruptor **Ver códigos DIAN**, arriba a la derecha, muestra los nombres técnicos de la DIAN junto a cada etiqueta (por ejemplo «DANE» o «schemeName») y los códigos delante de los nombres de las listas; empieza apagado. **Departamento** y **Municipio** son cajas de búsqueda: escribe «medellin» y pulsa **Enter**. El **DV** y el **Nombre para documentos** no se editan, pero se pueden seleccionar y copiar con el botón de copiar que tienen al lado; el **Resumen RUT** también copia la identificación completa («NIT 900373115-3»). Todo esto se explica en la guía **Moverse por el sistema**, «Llenar un formulario con el teclado».

Al guardar, la pestaña pasa a mostrar el tercero ya creado, con su **ID** consecutivo y su identificador (UUID).

## Correos y teléfono

- Un **cliente** necesita el **Correo de recepción de facturas de venta**: a él llegan nuestras facturas electrónicas.
- Un **proveedor** necesita el **Correo para enviar documentos al proveedor**: órdenes de compra, acuses y soportes.
- Si el tercero es **Cliente y proveedor** se piden los dos correos, porque cada uno cumple una función distinta.
- El **Teléfono principal** se guarda en dos partes: **indicativo del país** y **número**. Para Colombia el formulario te recuerda que un celular empieza por 3 y un fijo por 60, de 10 dígitos en total; para otros países se escriben solo dígitos, sin indicativo.
- Los correos y teléfonos se revisan al escribirlos: cuando el formato es válido ves «✓ formato válido» y, si no lo es, el botón de guardar queda bloqueado hasta que lo corrijas.

Para más personas de contacto usa la pestaña **Contactos** (guía **Contactos de un tercero**).

## Estado DIAN y «Listo para facturar»

El formulario separa dos situaciones:

- **Errores**: un dato con formato inválido (un número de documento con letras donde solo van dígitos, un correo mal escrito…). **Impiden guardar**; el panel lista cada error.
- **Datos pendientes**: faltan datos que la DIAN exige pero lo escrito es válido. **Se puede guardar**: el tercero queda con estado «Faltan N» y el panel enumera lo que falta. Complétalos cuando los tengas.

Un tercero está **Listo para facturar** solo cuando cumple las tres condiciones:

1. Su estado DIAN es **Completo**.
2. Está **Activo**.
3. Tiene cargados los **archivos obligatorios** que aplican a él (por defecto, para una empresa colombiana: el **RUT** en PDF y, si es persona jurídica, el certificado de **Cámara de Comercio** en PDF; la **Certificación bancaria** de un proveedor es opcional). Se adjuntan en la pestaña **Archivos** (guía **Archivos adjuntos**).

Si además tu empresa definió **datos adicionales obligatorios**, uno que falte aparece como «Dato adicional: …» en los datos pendientes.

Mientras no esté listo para facturar, el tercero no se puede elegir en una factura. En la parte baja del formulario, el panel **No se puede usar en facturas** te dice por qué. El pie del registro repite las dos cosas: «✓ Se puede usar en facturas» o «✕ No se puede usar en facturas», y el estado DIAN en palabras («DIAN: completo», «DIAN: faltan 4 datos»).

## Cambiar un tercero

Abre la fila, modifica lo que necesites y pulsa **Guardar**. **Descartar cambios** devuelve el formulario a lo guardado. El estado DIAN se recalcula en cada guardado. Si cambias el número de documento a uno que ya existe en la empresa, el sistema lo rechaza: no puede haber dos terceros con el mismo documento.

Para sacar de circulación a un tercero se **desactiva** (proceso «Desactivar tercero», con su propio permiso; en esta versión el formulario no tiene un botón para hacerlo): un tercero inactivo deja de estar disponible para documentos nuevos, pero se conserva todo su historial.

## Estados, aprobación, impresión y acceso

Los terceros son un **maestro** (guía [Maestros y documentos](maestros-y-documentos.md)):

- Cada un tercero tiene un **ID** consecutivo que nunca se repite; búscalo en la columna **ID** del listado o escribiéndolo en **⌘K**.
- La barra de acciones del registro tiene **Nuevo**, **Duplicar**, **Imprimir** (el PDF del registro, guía [Plantillas PDF e Imprimir](plantillas-pdf.md)) y **Guardar**. Si el administrador activó **Requiere aprobación** en **Parámetros › Configuración de tipos**, aparece también **Guardar y enviar a aprobación**, y quien tiene el permiso ve **Aprobar** y **No aprobar**. En un tercero aprobado, cambiar el documento, el nombre o los datos tributarios lo devuelve a **Pendiente de Aprobación** al guardar.
- Un maestro se puede usar en documentos cuando está **Activo** y aprobado (o grabado, si no requiere aprobación). Para dejar de usarlo, cambia **Activo** a «No»; **Eliminar** solo funciona si nada lo usa.
- El pie dice **Creado en … por …** y **Modificado en … por …**. Los maestros no tienen **Notificar** ni **Versiones**: sus cambios quedan en la auditoría.
- Un administrador puede restringir un tercero concreto a ciertos roles o usuarios en la pestaña **Acceso** (guía [Acceso por registro](acceso-por-registro.md)).

## Quién puede ver y cambiar qué

- Crear, actualizar, desactivar y consultar terceros son permisos distintos que el administrador asigna a cada rol. Sin el permiso de actualizar, el formulario se abre en solo lectura («Solo lectura: tu rol no puede modificar este registro»).
- Algunos campos pueden estar **enmascarados** (se ven como ••••••) o **ocultos** para tu rol; por ejemplo el cupo de crédito o el saldo. Un campo enmascarado tampoco se puede filtrar ni ordenar, y sale enmascarado en las exportaciones.
- Si el administrador marcó la creación o actualización de terceros como una acción sensible, al guardar te pide el código de 6 dígitos de tu app de autenticación (guía **Ingresar y verificación en dos pasos**).

## Más

- Pestañas del registro: **Datos · Contactos · Datos adicionales · Archivos** y, para los administradores, **Acceso**.
- **Duplicar** (o **Ctrl+D**) crea un tercero nuevo a partir de este, sin número de documento ni DV, contactos ni archivos (guía **Moverse por el sistema**, «Duplicar un registro»).
- Cada acción (crear, actualizar, desactivar) queda en la auditoría con quién la hizo y desde dónde.
- Para cargar muchos terceros de una vez, usa **Importar** (guía **Importar datos**).
