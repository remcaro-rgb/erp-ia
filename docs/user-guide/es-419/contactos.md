---
title: Contactos de un tercero
routes:
  - /parties
processes:
  - core.contact.create
  - core.contact.update
  - core.contact.delete
  - core.contact.list
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

Esas acciones corresponden a los permisos **Crear contacto**, **Actualizar contacto** y **Eliminar contacto** (`core.contact.create`, `core.contact.update`, `core.contact.delete`) y quedan en la auditoría. Quitar un contacto lo elimina de verdad (los contactos no son documentos), pero la auditoría conserva lo que se quitó. En esta versión la pestaña **Contactos** del formulario es de consulta: muestra la lista, pero los botones para agregar, editar y quitar contactos desde la pantalla aún no están habilitados. Mientras tanto, el contacto principal del tercero se mantiene con los campos **Persona de contacto**, **Correo** y **Teléfono** del formulario de **Datos**.
