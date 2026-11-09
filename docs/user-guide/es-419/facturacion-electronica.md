---
title: "Facturación electrónica: envío a la DIAN, estados, errores y «Reintentar envío»"
routes:
  - /invoicing/invoices
  - /invoicing/notes
  - /invoicing/settings
processes:
  - invoicing.invoice.reprice
  - invoicing.invoice.resubmit
  - invoicing.invoice.resubmit_failed
  - invoicing.invoice.void
  - invoicing.note.create
  - invoicing.note.issue
  - invoicing.note.resubmit
  - invoicing.settings.update
  - invoicing.dian_checklist.tick
  - invoicing.dian_checklist.consult
  - invoicing.dian_defaults.confirm
  - invoicing.certificate.upload
  - invoicing.software_pin.set
  - core.document_sequence.register
---

# Facturación electrónica: el envío a la DIAN

Cada factura que **emites** (guía **Facturas de venta**) se envía sola a la DIAN, sin que tengas que hacer nada. El sistema arma el documento electrónico con los valores que la factura tenía al emitirse (número, CUFE, líneas, impuestos y totales, aunque después cambie la tarifa de un producto), lo **firma** con el certificado digital de la empresa, guarda el XML firmado, lo **envía** y **consulta la respuesta** hasta que la DIAN la acepta o la rechaza. La respuesta de la DIAN queda junto al XML: el archivo guardado es exactamente el que la DIAN validó. El envío no cambia la factura: el número y el CUFE son los de la emisión y la contabilidad ya quedó hecha al emitir.

## Dónde lo ves

- En la lista de **Facturas** (y en la de **Notas crédito y débito**), la columna **Estado DIAN**; el filtro rápido **Rechazadas por la DIAN** deja solo las que debes corregir.
- En la ficha, arriba, el chip **Estado ante la DIAN**. Mientras el envío está en camino, el chip dice **En proceso**; si se detuvo o falta configurar el software, lo dice (**Envío detenido**, **Sin configurar**).
- En la pestaña **Datos**, el **Recorrido DIAN** (Emitida, Enviada a la DIAN, Aceptada o Rechazada) y, si la DIAN la rechazó, la lista **Errores de la DIAN** con el código y el mensaje de cada error, Mientras la factura se reenvía, esos errores siguen a la vista, con el aviso de que son los del último rechazo, hasta que la DIAN responda. **Reintentar envío** está en la barra de la ficha.
- En la pestaña **DIAN**, el detalle del envío: su estado, el número de envío (cada reenvío es uno nuevo), los intentos, el número de seguimiento de la DIAN, cuándo se envió y cuándo respondió, el último error y los archivos guardados para descargar: el **XML firmado**, la **respuesta de la DIAN** y el **PDF**. Cada descarga usa un enlace que vence a los pocos minutos; si vence, vuelve a pulsar el archivo.

## Los estados

En la factura, el **Estado DIAN** dice dónde va:

- **Sin enviar**: la DIAN aún no tiene la factura (un borrador, una emitida cuyo envío no ha empezado o un envío que no alcanzó a llegar).
- **En proceso**: la DIAN recibió el documento y el sistema espera su respuesta. Puede tardar unos segundos o, si la DIAN está lenta, varios minutos; el sistema vuelve a consultar cada vez con más espacio.
- **Aceptada**: la DIAN validó la factura. Es la versión que vale ante ella y ya no se reenvía.
- **Rechazada**: la DIAN encontró errores. La factura muestra la lista de errores tal como la DIAN los devolvió (el código y el mensaje de cada uno).

El estado solo avanza: de Sin enviar a En proceso, y de En proceso a Aceptada o Rechazada. Una factura rechazada vuelve a **En proceso** cuando la reenvías. Una aceptada no cambia más.

Además del estado DIAN, cada envío tiene su propio estado, que ves en el detalle de la factura: **En cola**, **Preparando**, **Enviada, esperando respuesta**, **Aceptada por la DIAN**, **Rechazada por la DIAN**, **Envío detenido** (el motivo aparece como **Último error**) y **Sin configurar** (la empresa aún no tiene su software DIAN registrado; ver abajo).

## Antes de emitir: fecha y precios

La DIAN exige que la factura lleve la fecha del día en que se genera, y el CUFE depende de ella. Por eso, al pulsar **Emitir**, la factura toma **la fecha de hoy** (la de la empresa) y los **impuestos se calculan con las tarifas vigentes en esa fecha**. La fecha que tenía el borrador queda como **Fecha de entrega o servicio**.

Los **precios no cambian solos al emitir**: el borrador conserva los precios que tiene. Si quieres ponerlos al día, pulsa **Recalcular precios** en la barra del borrador: cada línea toma el precio de lista de hoy de su producto (si el producto no tiene precio de lista, la línea conserva el suyo; el descuento no cambia) y los impuestos se calculan de nuevo. Los precios que escribiste a mano en una línea libre se reemplazan por la lista; las líneas facturadas desde un pedido conservan el precio acordado en el pedido. **Recalcular precios** solo funciona en facturas en la moneda de la empresa (pesos): la lista de precios está en pesos, así que en un borrador en otra moneda (por ejemplo dólares) el sistema lo rechaza y deja los precios que escribiste. El botón no aparece en una factura ya emitida: allí se corrige con una nota.

El borrador guarda la **Fecha de los precios**, el día en que se pusieron sus precios (al crearlo, al cambiar sus líneas o al recalcular). Si no es hoy, la ficha muestra el aviso **«Los precios son del <fecha>; usa Recalcular precios para actualizarlos»**. El aviso no impide emitir: emitir con esos precios es una decisión tuya. Al emitir, el sistema responde de nuevo con ese aviso si los precios eran de otro día.

## «Reintentar envío»

**Reintentar envío** vuelve a mandar una factura emitida que no quedó aceptada. Está en la pestaña **Datos** de la factura (o de la nota) y también lo puedes pedir al **asistente**. No pide código de verificación.

- **Rechazada**: primero corrige lo que la DIAN señaló. Lo que se corrige en los maestros (por ejemplo, el correo o la dirección del cliente en **Terceros**) entra en el nuevo envío; el número y el CUFE siguen siendo los mismos. Si reenvías sin corregir nada, la DIAN la vuelve a rechazar con los mismos errores.
- **Envío detenido**: retoma donde quedó, con el mismo XML firmado. Si el documento ya había llegado a la DIAN, el sistema consulta su respuesta con el mismo número de seguimiento; nunca lo manda dos veces.
- **Sin configurar**: después de registrar el software y las credenciales, Reintentar envío manda la factura por primera vez.

Si un envío falla antes de llegar a la DIAN (por ejemplo, se cae la conexión), el sistema lo reintenta solo: primero pregunta a la DIAN si ya tiene el documento y únicamente lo manda de nuevo si la DIAN responde que no lo recibió.

No se puede reintentar una factura **Aceptada** (corrígela con una nota crédito o débito) ni una cuyo envío está en curso (espera la respuesta).

Lo que cambia el CUFE (la fecha, el cliente, los valores o los impuestos) no se corrige reenviando: la factura emitida queda como está y se corrige con una nota.

**Reintentar todos** (en **Parámetros de facturación**, tarjeta **Envíos pendientes**, o pidiéndolo al asistente) hace lo mismo, de una vez, con todas las facturas y notas emitidas cuyo envío quedó **Envío detenido** o **Sin configurar** (las que se emitieron antes de registrar el software). Puedes limitarlo a las que esperaban el software o a las que se detuvieron por un motivo (por ejemplo, por la moneda, después de que se habilitó el envío en moneda extranjera). Lo que la DIAN ya recibió no se reenvía. **Solo el administrador de la empresa** puede usar Reintentar todos. Quien no lo es ni siquiera abre **Parámetros de facturación**; si lo pide al asistente, este responde «Solo el administrador de la empresa puede reintentar todos los envíos» y no se reenvía nada. El **Reintentar envío** de una factura o nota, en cambio, sigue disponible para quien tenga permiso sobre ese documento.

## Notas crédito y débito

Una factura que la DIAN **aceptó** no cambia: se corrige con una nota.

- La **nota crédito** baja lo que el cliente debe: una devolución parcial, una rebaja, un ajuste de precio o un descuento.
- La **nota débito** lo sube: intereses, gastos por cobrar, un cambio del valor u otros.

Para crearla abres la factura y, en la pestaña **Datos**, pulsas **Crear nota crédito** o **Crear nota débito** (guía **Facturas de venta**); eliges el **concepto de corrección** (los de la tabla de la DIAN para ese tipo de nota), el **motivo** y las líneas de la factura que corriges, con su cantidad y su precio. Los impuestos se calculan con las tarifas que tenía la factura. Una nota siempre corrige una factura de venta, nunca otra nota.

Al **emitirla**:

- La nota toma la fecha de hoy y su propio número, de su propia numeración: una para las notas crédito y otra para las débito.
- Se contabiliza en **su propio mes**, aunque la factura sea de un mes anterior ya cerrado. Una nota crédito parcial va a **devoluciones en ventas** (por su concepto); una nota débito va al ingreso de la categoría de cada línea, como la factura.
- Se envía sola a la DIAN, con su **CUDE** y la referencia a la factura (su número y su CUFE). Tiene los mismos estados y el mismo **Reintentar envío** que una factura.

Una nota crédito no puede superar lo que queda de la factura: su total, más sus notas débito, menos las notas crédito que ya tiene. Cada línea de la factura se acredita como máximo una vez, en cantidad y en valor, contando las otras notas crédito de la factura, emitidas **y en borrador**: si una nota en borrador ya toma una línea, elimínala o emítela antes de hacer otra. Una nota nombra cada línea de la factura una sola vez.

Una nota crédito parcial no cambia lo que figura como facturado de las entregas: solo la anulación de la factura las devuelve a **por facturar**.

Una nota emitida no se anula: si quedó mal, se corrige con otra nota. Una nota en borrador se elimina.

Las líneas con impuestos distintos del IVA y del INC, y las muestras gratis, se corrigen solo anulando la factura.

## Anular una factura

**Anular (nota crédito)**, en la barra de la ficha de la factura (guía **Facturas de venta**), emite la **nota crédito de anulación**: la nota completa de la factura, con el concepto «Anulación de factura electrónica» y el CUFE de la factura, y la manda a la DIAN.

- La factura sigue **Emitida** mientras la DIAN no acepte la nota. Cuando la acepta, la factura queda **Anulada**, con la nota que la anuló, y su número no se vuelve a usar.
- Solo se anula una factura **Aceptada**:
  - si la DIAN la **rechazó**, corrígela y usa Reintentar envío;
  - si aún está **Sin enviar** o **En proceso**, espera la respuesta;
  - si su envío se **detuvo** o está **Sin configurar**, resuélvelo y reintenta.
- Una factura que ya tiene una nota crédito o débito, o pagos aplicados, no se anula. Pedir Anular otra vez mientras la DIAN responde no crea una segunda nota.
- Mientras exista la nota de anulación (en camino a la DIAN, o rechazada y por reenviar), la factura no admite otras notas, ni crédito ni débito. Si la DIAN la rechaza, corrige lo que señaló y usa **Reintentar envío** en la nota: cuando la DIAN la acepte, la factura queda anulada.
- La anulación devuelve cada valor a la cuenta donde la factura lo registró: el ingreso por la categoría de cada línea, el IVA por su tarifa y la cuenta por cobrar del cliente.

La nota de anulación no se crea a mano: solo la emite Anular.

## Facturas de exportación y en moneda extranjera

Una factura en dólares u otra moneda de la tabla de la DIAN se envía en **su moneda**, con la **tasa de cambio** (TRM) de la factura. Su CUFE se calcula con los valores en esa moneda.

Si el cliente es del exterior, la factura sale como **factura de exportación** y sus notas crédito como notas de exportación, en la misma moneda y con la misma tasa. El cliente del exterior se identifica con su documento extranjero y su país; no lleva departamento ni municipio de Colombia.

## Errores frecuentes y qué hacer

- **La facturación electrónica no está configurada**: registra el software, el PIN y el certificado de la empresa (ver abajo) y pulsa Reintentar envío.
- **Falta el certificado digital o el PIN del software**: cárgalos en **Parámetros de facturación** y reintenta.
- **El ambiente de la empresa no coincide con el servidor** (einvoice_environment_mismatch): la empresa está en producción y el servidor no está configurado para la DIAN de producción (o al revés). Nada se envió; quien administra el servidor corrige la configuración y luego reintentas.
- **La DIAN no respondió a tiempo**: el sistema consultó muchas veces sin respuesta. Reintentar envío consulta de nuevo el mismo envío, sin reenviarlo.
- **El envío anterior pudo llegar a la DIAN y su número de seguimiento no se conoce**: busca la factura en el portal de la DIAN antes de hacer nada más.
- **El documento ya no coincide con el CUFE**: algo que entra en el CUFE cambió desde la emisión (por ejemplo, la resolución DIAN registrada); corrígela con una nota.
- **La factura cambió desde que se emitió**: los valores guardados de la factura no cuadran entre sí; corrígela con una nota y avisa a soporte.
- **La moneda de la factura no está en la tabla de monedas de la DIAN**: la factura no se puede enviar; corrígela con una nota.
- **La DIAN rechazó esta factura / aún no se ha enviado / su envío se detuvo**: una nota o una anulación solo corrige una factura **Aceptada**. Reintenta el envío o espera la respuesta.
- **La nota crédito supera lo que queda de la factura**: baja la cantidad o el precio de las líneas de la nota.
- **El documento de la nota ya no coincide con el CUDE de su primer envío**: la nota quedó como se emitió; corrígela con otra nota.

## La representación gráfica (PDF)

Cuando la DIAN **acepta** una factura o una nota, el sistema guarda su **PDF** junto al XML firmado y la respuesta de la DIAN. El PDF es la **representación gráfica** del documento electrónico: los datos de la factura y sus líneas y, al pie,

- el **código QR** de la consulta del documento en el catálogo de la DIAN (con su CUFE o CUDE);
- el **CUFE** (en la factura) o el **CUDE** (en la nota);
- en la factura, la **leyenda de la resolución de numeración**: número de la resolución, prefijo, rango autorizado y vigencia;
- en la nota, la factura que corrige (su número y su CUFE);
- en habilitación, el aviso **«Documento de prueba (habilitación DIAN): sin validez fiscal»**; un documento que la DIAN aún no acepta dice que está pendiente de validación.

El **ambiente** de cada factura y de cada nota queda fijo al **emitirla**: su CUFE o CUDE se calculó con él. Su PDF, su QR y su envío siguen ese ambiente aunque la empresa pase después a producción: una factura emitida en habilitación siempre se imprime como documento de prueba. Lo mismo vale al **reenviar**: Reintentar envío y Reintentar todos mandan el mismo documento, con el mismo número y CUFE y con el ambiente en que se emitió, y su QR sigue siendo el de ese ambiente, aunque hoy la empresa esté en otro. Si un documento emitido no tuviera registrado su ambiente (no debería pasar), el sistema no lo adivina con el de la empresa: el envío y la impresión se detienen con el aviso «El documento no tiene registrado el ambiente DIAN en que se emitió».

El PDF guardado no se reemplaza nunca. **Imprimir** desde la factura arma el mismo documento con la plantilla de la empresa (o la del sistema, si la empresa no eligió una; guía **Plantillas PDF e Imprimir**). Un borrador se imprime sin QR, sin CUFE y sin leyenda.

## Configurar el envío

Todo se configura en **Facturación › Parámetros › Parámetros de facturación** (la página **Facturación electrónica**). Solo la abren los **administradores de la empresa** (y solo ellos pueden guardar estos parámetros, aunque otro rol tenga los permisos), y cada cambio pide el **código de verificación**, salvo **Reintentar todos**.

### Creación de facturas

Cuándo se crean las facturas (a mano, al despachar cada entrega o al confirmar el pedido) y los **días de crédito** (guía **Facturas de venta**).

### Conexión DIAN

- El **ambiente DIAN**: **Habilitación** mientras se hacen las pruebas con la DIAN, **Producción** después.
- El **identificador del software** que la empresa registró ante la DIAN, el **NIT del proveedor del software** (sin dígito de verificación) y, en habilitación, el **identificador del set de pruebas**.
- El perfil fiscal del emisor: **responsabilidades fiscales** (códigos separados por comas), **tributo**, y los códigos DANE del **departamento** y el **municipio**.
- **Valores por defecto DIAN: n de 23 verificados** (o **confirmados**) y el enlace **Abrir la lista de verificación**: los valores por defecto ya no se confirman con una casilla, sino en la **Lista de verificación DIAN** (más abajo).

**Pasar a producción** solo se permite cuando todo está listo; si falta algo, el cambio se rechaza, la empresa sigue en habilitación y el mensaje dice qué falta:

1. la **lista de verificación DIAN** confirmada y vigente (sección siguiente; mientras la empresa esté en producción no se puede retirar). Si falta, el mensaje dice cuántos valores quedan por verificar;
2. el servidor configurado para enviar a la DIAN en producción (lo configura quien administra el servidor). El **simulador** de la DIAN y la conexión de **habilitación** nunca envían documentos de una empresa en producción: si el servidor no coincide con el ambiente de la empresa, el envío se detiene antes de mandar nada, con el error **«einvoice_environment_mismatch»**;
3. el software registrado, el **certificado** y el **PIN**;
4. el certificado **vigente** y el mismo que está guardado (si la página avisa que el certificado guardado no coincide, súbelo de nuevo).

Volver a habilitación siempre se permite.

Las **notas** crédito y débito se emiten en el ambiente de la factura que corrigen: una nota de una factura emitida en habilitación es también de habilitación, aunque la empresa ya esté en producción. Lo mismo al revés: la nota de una factura emitida en **producción** va a la DIAN de **producción**, aunque después se retire la confirmación de la lista de verificación DIAN o la empresa vuelva a habilitación; una factura de producción se corrige en producción, donde se emitió.

### Lista de verificación DIAN

Se abre desde **Conexión DIAN › Abrir la lista de verificación** (**Facturación › Parámetros › Facturación electrónica › Lista de verificación DIAN**; no tiene opción propia en el menú). Solo la abren los **administradores de la empresa**. Son los **23 valores** que los documentos llevan hoy, escritos según los anexos de la DIAN y probados con el simulador, que **nadie ha verificado todavía en la habilitación de la DIAN**. Antes de pasar a producción, el administrador verifica cada uno en la habilitación y lo marca; con los 23 marcados puede **Confirmar valores por defecto**, y solo así la empresa puede pasar a producción (además del servidor, el software, el certificado y el PIN).

**Cómo se usa.** Marca las casillas (o usa **Seleccionar el grupo** para marcar un grupo entero) y pulsa **Marcar los seleccionados**: una sola ejecución, con **un** código de verificación, marca todo lo seleccionado. Bajo cada valor marcado verás **Verificado por** quién y cuándo. La barra muestra el avance (**n de 23 verificados**). **Confirmar valores por defecto** se habilita solo con los 23 marcados y sin cambios pendientes de guardar, y también pide el código; después la página dice **Valores confirmados el** (fecha) **por** (nombre).

**Desmarcar.** Desmarcar cualquier valor (el botón pasa a **Guardar cambios**) deja sin efecto la confirmación en el mismo paso: la página avisa **Confirma de nuevo los valores por defecto** y, cuando vuelvan a estar los 23 marcados, se confirma otra vez. **En producción no se puede desmarcar** (la confirmación no se retira ahí): para cambiar la verificación, vuelve primero a habilitación. Cada marca y cada desmarca queda en la **auditoría** con quién, cuándo y desde dónde.

**Cuando llega un valor nuevo.** Si una versión del sistema agrega un valor a la lista, la confirmación anterior **deja de valer en ese momento**: el valor nuevo aparece con la etiqueta **Nuevo** y un aviso rojo (**Hay n valores nuevos por verificar**). Marca los nuevos y confirma de nuevo. Una empresa que **ya está en producción** sigue enviando documentos con normalidad (el aviso solo le pide verificar los valores nuevos); pasar a producción otra empresa necesita la confirmación vigente.

**Qué verifica el administrador en cada valor.** En la habilitación de la DIAN, comprueba que el documento que el sistema arma sea aceptado con:

1. **Notas y tipos de documento**
   - **Tipo 91 en las notas crédito** (CreditNoteTypeCode nacional): que la DIAN acepte una nota crédito nacional con ese tipo.
   - **CustomizationID 10 en las exportaciones**: que acepte ese valor en facturas y notas de exportación (el ejemplo de la DIAN v1.9 usa 04 y 11).
   - **Sin DebitNoteTypeCode en exportación**: que acepte una nota débito de exportación sin ese código.
   - **Sin InvoiceControl en las notas**: que acepte notas crédito y débito sin esa extensión.
   - **Numeración de las notas con la forma de una resolución**: que acepte la numeración de notas que el sistema reutiliza.
2. **Firma y software**
   - **SoftwareSecurityCode con el número del documento**: que acepte el tercer elemento como número del documento (otro sistema usaba el NIT).
   - **Sin sts:QRCode**: que acepte las extensiones sin ese elemento (el Anexo 1.8 o posterior puede exigirlo).
   - **Canonicalización de la firma**: que valide la firma tal como se escribe.
3. **Respuesta de la DIAN y reenvío**
   - **Mapa de códigos 00 / 66 / 90 / 98 / 99**: que cada código signifique lo que el sistema supone, y si el 90 es «nunca recibido».
   - **GetStatus con el CUFE como trackId**: que la consulta con el CUFE devuelva el estado.
   - **Reenvío de un rechazado con el mismo número y CUFE**: que lo reciba como el mismo documento corregido.
   - **Pérdida del ZipKey en el set de pruebas asíncrono**: que el envío quede **en duda** (aviso «submission_in_doubt») y se pueda verificar en el portal.
   - **Espera entre consultas**: que 20 consultas (cerca de 2,5 horas) alcancen para recibir la respuesta.
4. **Impuestos e importes**
   - **Muestras gratis**: que acepte el TaxTotal y el AlternativeConditionPrice de una línea de muestra.
   - **Otros impuestos por unidad**: que acepte PerUnitAmount y BaseUnitMeasure.
   - **TaxExclusiveAmount con líneas excluidas y ZZ**: que el total sin impuestos cuadre.
5. **Medios de pago y compradores**
   - **Subconjunto de la tabla 13.3.4.2** (1, 10, 20, 42, 47, 48, 49, 71, ZZZ): que los medios que usa la empresa estén aceptados.
   - **Documentos de compradores extranjeros reducidos a dígitos**: que acepte esos números.
   - **Exportación = país del cliente distinto del de la empresa**: que la DIAN trate así esas facturas.
6. **Perfil fiscal del emisor**
   - **Perfil del emisor** (O-13 / R-99-PN, tributo 01 o ZZ, códigos DANE): que coincida con el RUT de la empresa; el sistema lo revisa solo al armar el documento.
7. **Infraestructura**
   - **Estado de las ejecuciones durables** en los entornos de Vercel y de Postgres: lo verifica quien administra el servidor (solo se probó en el entorno de pruebas en proceso).
8. **Tablas de referencia**
   - **Valores de la UVT 2023 y 2024**: se escribieron de memoria y hoy no se usan; confirma que ninguna regla de la empresa los necesite.
   - **Tarifas de otros impuestos** (bolsas, ICL, IBUA, ICUI, carbono): no están cargadas; confirma que la empresa no los facture, o pide cargarlas.

El asistente **no** marca estos valores ni confirma los valores por defecto: es una decisión del administrador, con su código de verificación, en esta página.

### Resolución y numeración

La tabla **Numeraciones registradas** muestra cada numeración: el documento, el prefijo, el número de la resolución, el rango, la vigencia, el **siguiente número** y los últimos caracteres de la **clave técnica** (nunca la clave completa). La clave completa no se vuelve a mostrar en ninguna parte (ni en la auditoría) y el asistente no puede registrarla: solo se escribe en esta página.

Para registrar la **resolución DIAN de facturación**, elige **Factura electrónica de venta** y escribe el **prefijo** (hasta 4 letras o números; vacío si la resolución no tiene), el **número de resolución**, el rango (**desde** y **hasta**), la vigencia (**vigente desde** y **vigente hasta**) y la **clave técnica** que la DIAN entrega con la resolución. Al **renovar** la resolución de un mismo prefijo, la nueva reemplaza a la anterior y el consecutivo sigue donde iba. Las facturas emitidas con la resolución anterior que aún no llegan a la DIAN (pendientes, rechazadas o detenidas) se siguen enviando con la clave técnica de **su** resolución. El **siguiente número** es opcional: vacío, una numeración nueva empieza en el primero del rango.

Las **notas crédito y débito** tienen cada una su numeración, con su **prefijo** (por ejemplo, NC y ND) y el siguiente número. Las notas **no llevan resolución DIAN**: la DIAN autoriza rangos solo para las facturas. Si falta la numeración de un tipo de nota, la nota no se emite y queda en borrador sin gastar número, y **Anular** una factura se rechaza (con el aviso de registrar la numeración de notas crédito) sin cambiar nada.

El consecutivo **nunca retrocede**: un siguiente número menor que el que ya lleva se rechaza, porque esos números ya pueden estar en documentos emitidos. Se rechaza también una resolución vencida o cuyo rango o vigencia no cuadran.

### Certificado de firma digital

Elige el **archivo .p12** de la empresa, escribe su **contraseña** y pulsa **Subir certificado**. Antes de guardarlo, el sistema revisa que:

- sea un certificado de firma **.p12 (PKCS#12)** con su llave privada;
- la contraseña lo abra;
- esté **vigente** (ni vencido ni por empezar);
- sea del **NIT de la empresa**.

El certificado y su contraseña se guardan **cifrados en el almacén de secretos** (Supabase Vault) y no se pueden volver a ver ni descargar: la página muestra solo el **titular**, su **NIT**, el **emisor**, el **serial**, el **vencimiento** y la fecha en que se subió. Para cambiarlo, sube el nuevo: reemplaza al anterior. Subir el certificado solo se hace desde esta página (el asistente no lo recibe).

La página revisa, cada vez que la abres, que el certificado guardado sea el que describen esos datos. Si una subida quedó a medias (el certificado nuevo alcanzó a guardarse pero sus datos no), o si en el almacén de secretos no hay certificado, la página lo avisa en rojo: **súbelo de nuevo**. Un certificado subido antes de esta revisión también pide subirse de nuevo para verificarlo.

Si el almacén de secretos **no responde** en ese momento, la página no marca el certificado como equivocado: avisa en rojo **«No se pudo verificar el certificado guardado (el almacén de secretos no respondió): inténtalo de nuevo en unos minutos»**. Vuelve a abrir la página pasados unos minutos; no hace falta subir el certificado otra vez. Mientras no se pueda verificar, el sistema tampoco deja pasar a producción: al guardar el cambio de ambiente responde «No se pudo verificar el certificado guardado: el almacén de secretos no respondió; inténtalo de nuevo» (no es un aviso de que el certificado esté mal). Cuando el almacén responde y el certificado coincide, no aparece ningún aviso.

### PIN del software

El **PIN del software** que la empresa registró ante la DIAN se guarda igual que el certificado: cifrado, sin volver a mostrarse. La página dice cuándo se guardó.

### Envíos pendientes

Cuántas facturas y notas esperan el registro del software y cuántas tienen su envío detenido, y el botón **Reintentar todos** (ver arriba).

Mientras la empresa no tenga su software registrado, las facturas se emiten y se contabilizan con normalidad, y su envío queda **Sin configurar**.

> **Nota de esta versión.** El envío trabaja hoy con un **simulador de la DIAN** (el valor por defecto del sistema): ninguna factura sale a la DIAN real y sus PDF dicen que no tienen validez fiscal. La conexión con la DIAN se activa cuando la empresa termine su habilitación, cargue sus credenciales y el servidor se configure para la DIAN.
