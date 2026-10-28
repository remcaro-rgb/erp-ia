---
title: Archivos adjuntos
routes:
  - /parties
  - /products
  - /categories
processes:
  - kernel.attachment.add
  - kernel.attachment.list
  - kernel.attachment.remove
---

# Archivos adjuntos

Todo registro (tercero, producto, categoría, ticket de soporte) tiene una pestaña **Archivos** para guardar los documentos que lo respaldan: el RUT de un cliente, la ficha técnica de un producto, una captura de pantalla de un problema.

## Adjuntar archivos

1. Abre el registro y entra a la pestaña **Archivos**. Si el registro todavía no está guardado, la zona dice «Guarda el registro para adjuntar archivos».
2. **Arrastra los archivos** a la zona punteada («Arrastra los archivos aquí»), o pulsa **elígelos** para escogerlos en tu computador. Puedes soltar varios a la vez.
3. En la lista **Por subir** asigna una **etiqueta** a cada archivo, porque cada archivo debe tener una. Elige una de la lista si aparece o elige **Otra…** y escribe la tuya (hasta 80 caracteres), por ejemplo «RUT» o «Contrato». Si escribes una etiqueta que tu empresa ya definió, se usa tal como la definió y se respeta el tipo de archivo que exige. Con la ✕ sacas un archivo de la lista antes de subirlo.
4. Cuando todos tengan etiqueta, el mensaje cambia a «Listo para subir». Pulsa **Subir N archivos**.

Cada archivo subido aparece en **Archivos adjuntos** con su etiqueta, su nombre, el tamaño, quién lo subió y cuándo.

### Reglas

- **25 MB** como máximo por archivo.
- No puede haber dos archivos con el mismo nombre en el mismo registro (sin importar mayúsculas): «Ya existe un archivo … en este registro».
- Si la etiqueta exige un tipo de archivo, se respeta: por ejemplo, la etiqueta **RUT** exige un **PDF** («La etiqueta RUT exige un archivo PDF»). El sistema revisa el contenido real del archivo, no solo su extensión.
- Si un archivo falla, se queda en la lista **Por subir** con el motivo, y los demás se suben igual.
- Para adjuntar o quitar archivos necesitas poder **actualizar** ese tipo de registro (por ejemplo, actualizar terceros). Con solo permiso de consulta puedes ver y descargar, pero no cambiar.

## Archivos obligatorios

Cada empresa tiene su lista de archivos obligatorios por tipo de registro, cada uno con la condición en que se exige. Por defecto, en una empresa colombiana:

| Registro | Etiqueta | Tipo | ¿Obligatorio? |
| --- | --- | --- | --- |
| Tercero | **RUT** | PDF | Sí, para terceros de Colombia |
| Tercero | **Cámara de Comercio** | PDF | Sí, para personas jurídicas de Colombia |
| Tercero | **Certificación bancaria** | PDF | No (útil para proveedores) |
| Producto | **Ficha técnica** | PDF | No |

Mientras falte un archivo obligatorio, el tercero o el producto **no está «Listo para facturar»**: en un buscador de terceros se ve como no facturable con el motivo «Faltan archivos obligatorios». En cuanto subes el último, queda listo (si lo demás está completo), y si quitas un archivo obligatorio, deja de estarlo.

## Descargar

Pulsa **Descargar** en el archivo. El navegador lo abre con un enlace seguro que dura 60 segundos; si pasa ese tiempo, vuelve a pulsar **Descargar**.

## Quitar un archivo

1. Pulsa la **✕** que está a la derecha del archivo.
2. El sistema pregunta «¿Quitar [nombre] ([etiqueta])? Deja de estar disponible pero queda en auditoría.»
3. Confirma con **Sí, quitar**, o cancela con **No**.

El archivo deja de verse y de poder descargarse, pero no se borra del todo: se conserva para la auditoría, que registra quién lo quitó y cuándo.

## Fotos de un producto

Las fotos de un producto son archivos con la etiqueta «Foto»: se agregan desde la pestaña **Fotos** (guía **Productos**) y también aparecen aquí.

## Tickets de soporte

Los archivos de un ticket se adjuntan en su pestaña **Archivos**; un ticket cerrado ya no recibe archivos nuevos (guía **Soporte**).
