---
title: "Reglas contables"
routes:
  - /accounting/posting
processes:
  - accounting.chart.seed
  - accounting.posting_rule.create
  - accounting.posting_rule.update
  - accounting.posting_rule.disable
  - accounting.posting_rule.consult
  - accounting.posting_rule.test
  - accounting.posting_rule.sync_defaults
  - accounting.account_role_mapping.update
  - accounting.account_role_mapping.consult
  - accounting.settings.update
  - accounting.settings.consult
---

# Reglas contables

Una **regla contable** dice cómo se contabiliza cada hecho de la empresa: «cuando se emite una factura de venta, débito a clientes, crédito a ventas e impuestos». Así los comprobantes automáticos nacen solos. Entra por **Contabilidad › Reglas contables**; sus secciones son **Reglas**, **Mapeo de cuentas**, **Conceptos exógena**, **Pendientes de contabilizar** y **Configuración**.

## Primera vez: Configurar contabilidad

Si la contabilidad aún no está configurada, la pantalla ofrece **Configurar contabilidad** (solo el administrador). Instala el plan de cuentas del país, el mapeo de roles, las fuentes, los conceptos de exógena, el año fiscal y las reglas por defecto. Pide el código de verificación. Puedes ejecutarlo otra vez: solo agrega lo que falte y nunca cambia lo que editaste.

## Mapeo de cuentas

Cada regla habla de **roles contables** (clientes, ventas, caja, IVA generado…), no de números de cuenta. En **Mapeo de cuentas** cada rol tiene su **Cuenta**; la pantalla dice «Todos los roles tienen cuenta» o cuántos faltan (en rojo, **Sin cuenta**). Para cambiar una, escoge otra cuenta en la lista y **Guardar** (pide código de verificación).

Algunos roles pueden variar por **Dimensión**: por ejemplo, la cuenta de ingresos por categoría de producto, que también se edita en la pestaña **Contabilidad** de la categoría.

## Reglas

El listado de **Reglas** muestra Evento, Módulo, Fuente, Prioridad y si está **Activa**; una insignia **Modificada** marca las que cambiaste frente a las de fábrica. Abre una:

- **Datos**: evento, fuente, prioridad, activa.
- **Líneas**: la plantilla, una fila por línea del comprobante: **Rol** (o **Cuenta fija**), **Lado** (Débito o Crédito), **Valor** (la ruta del dato en el evento, por ejemplo `$.totals.total`), **Dimensión**, tercero, centro de costo y demás. **Agregar línea** o **Quitar la línea n**.
- **Probar**: elige un **Evento real** y pulsa **Probar con un evento real** para ver la **Vista previa** del comprobante que saldría, sin contabilizar nada.
- **Historial**: los cambios de la regla (solo el administrador).

Para cambiarla: edita las líneas, pruébalas y pulsa **Guardar** (pide el código de verificación). Cada cambio queda en la auditoría.

[Captura: regla contable con sus líneas y la vista previa]

## Configuración

- **Dimensiones analíticas en uso**: **Usar auxiliares abiertos**, **Usar ítems**, **Usar unidades de negocio**.
- **Comprobantes manuales**: **Exigir aprobación de otra persona**, **Exigir un archivo adjunto** y **Fuente de los comprobantes manuales**.
- **Grupo NIIF** (1, 2 o 3) y **Tolerancia de ajuste al peso**: la diferencia máxima que se absorbe al cuadrar un comprobante automático.
- **El libro empieza el**: los eventos anteriores a esa fecha se reconocen sin contabilizar.

Guarda con **Guardar**; pide el código de verificación.

## Conceptos exógena y Pendientes

Tienen sus guías: **Información exógena** y **Pendientes de contabilizar**.

## Pedirle al asistente

«Las ventas de la categoría Bebidas deben ir a la 413520» propone el cambio de mapeo en una tarjeta con el antes y el después y pide el código de verificación antes de aplicarlo.
