---
title: Contactos de un tercero
routes:
  - /parties
processes:
  - core.contact.create
  - core.contact.update
  - core.contact.delete
  - core.contact.list
  - kernel.verify.request
---

# Contactos de un tercero

Además del correo y el teléfono principales del tercero, puedes tener las **personas de contacto** de cada cliente o proveedor: la persona de compras, de tesorería, de logística… Viven en la pestaña **Contactos** del tercero.

## Dónde verlos

1. Abre **Terceros** y haz clic en el tercero.
2. Entra a la pestaña **Contactos**. El número junto al nombre de la pestaña es la cantidad de contactos.
3. La tabla muestra, por contacto: **Nombre**, **Cargo**, **Correo**, **Teléfono**, **Extensión** y **Celular**. Si el tercero no tiene contactos, ves «Sin contactos. Agrega a las personas con quienes tratas: compras, tesorería, logística.»

Los contactos se ven según el permiso de tu rol y respetan el alcance de terceros de tu rol: si tu rol solo ve clientes, solo ves los contactos de clientes. Los campos enmascarados u ocultos para tu rol se muestran igual que en el resto del sistema.

## Qué se guarda de cada contacto

- **Nombre** (obligatorio, hasta 200 caracteres).
- **Cargo** (hasta 100 caracteres).
- **Correo**, con el mismo control de formato que el correo del tercero.
- **Teléfono** y **Celular**, cada uno con su **indicativo del país** y su número.
- **Extensión** (solo dígitos, hasta 6).
- Los formatos del correo y de los teléfonos se validan al guardar: un dato mal escrito se rechaza con el motivo («Correo: …», «Teléfono: …», «Celular: …»).

## Agregar, cambiar y quitar contactos

Todo se hace desde la pestaña **Contactos** del tercero:

1. **Agregar**: pulsa **+ Nuevo contacto**, llena el formulario y pulsa **Agregar contacto**. El botón se habilita cuando hay nombre, el correo y los teléfonos tienen formato válido y hay al menos un medio de contacto (correo, teléfono o celular); si falta algo, el formulario lo dice («El nombre es obligatorio», «Indica al menos un correo o teléfono»).
2. **Cambiar**: haz clic en el nombre del contacto (o en cualquier parte de su fila), corrige y pulsa **Guardar contacto**.
3. **Quitar**: pulsa la ✕ de la fila y confirma con **Sí, quitar** (o cancela con **No**).

Si el sistema rechaza el contacto (por ejemplo «Correo: …» o un tercero fuera del alcance de tu rol), el formulario sigue abierto y muestra el motivo bajo los botones. Después de cada cambio la lista se actualiza y el número de la pestaña también.

Cada acción es un permiso aparte de tu rol: **Crear contacto** (`core.contact.create`), **Actualizar contacto** (`core.contact.update`) y **Eliminar contacto** (`core.contact.delete`). Solo ves los controles que tu rol puede usar: sin **Crear contacto** no aparece **+ Nuevo contacto**; sin **Actualizar contacto** la fila no abre el formulario; sin **Eliminar contacto** no hay ✕. Todo queda en la auditoría. Quitar un contacto lo elimina de verdad (los contactos no son documentos), pero la auditoría conserva lo que se quitó.

## Verificar el correo y el teléfono

Junto a un correo o un teléfono con formato válido aparece **Verificar ↗**. Al pulsarlo se pide la verificación externa (permiso **Verificar un dato**, `kernel.verify.request`). Mientras tu empresa no tenga un proveedor de verificación configurado, la solicitud queda **en cola** y el control lo muestra con la marca «en cola»; no bloquea el guardado. La solicitud se registra sobre el tercero y el dato verificado.

## Contactos y contacto principal

El contacto principal del tercero (campos **Persona de contacto**, **Correo** y **Teléfono** del formulario de **Datos**) es independiente de esta lista: la pestaña **Contactos** sirve para todas las demás personas.
