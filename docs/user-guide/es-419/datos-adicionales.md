---
title: Datos adicionales
routes:
  - /parties
  - /products
  - /categories
processes:
  - kernel.custom_field.set
  - kernel.custom_field.remove
  - kernel.custom_field.list
  - core.party.update
  - core.product.update
  - core.category.update
---

# Datos adicionales

Cada empresa necesita guardar información propia que el sistema no trae de fábrica: la zona de venta de un cliente, el código del proveedor en tu contabilidad, la fecha de vencimiento de una certificación. Los **datos adicionales** son esos campos extra. Aparecen en la pestaña **Datos adicionales** de cada registro, y también como columnas y filtros en los listados.

## Dos clases de datos

- **Definidos por el administrador**: los crea el administrador de la empresa para un tipo de registro (terceros, productos, categorías…). Todos los registros de ese tipo los tienen.
- **Datos libres**: pares de **nombre** y **valor** (hasta 200 caracteres cada uno) que cualquier usuario puede agregar a un registro, sin reglas ni permisos especiales.

## Cómo se definen (administrador)

Solo el **administrador de la empresa** define datos adicionales, con el proceso «Define o cambia un dato adicional». Es una acción sensible: pide el código de 6 dígitos de tu app de autenticación (guía **Ingresar y verificación en dos pasos**). Quitar la definición de un dato también lo pide. Para cada dato se indica:

- La **entidad** a la que pertenece y su **nombre** interno.
- El **tipo**: **Texto**, **Número**, **Fecha** (AAAA-MM-DD), **Sí / No**, **Lista** (con sus opciones), **URL** o **Correo**.
- La **longitud máxima** (para textos).
- Si es **obligatorio**.
- Qué **roles** pueden **ingresarlo**, **editarlo** y **verlo**.

Si quitas la definición de un dato, los valores ya guardados se conservan pero nadie los ve.

## Cómo se ven

1. Abre un registro (por ejemplo un tercero) y entra a **Datos adicionales**. El número junto al nombre de la pestaña cuenta los datos definidos más los libres; si hay datos pendientes (obligatorios vacíos o con errores) aparece además una insignia roja con su cantidad.
2. En **Definidos por el administrador** ves cada dato con su tipo y límites (por ejemplo «Texto · máx. 20»), una marca **obligatorio** si lo es, y su valor.
3. En **Datos libres** ves los pares nombre y valor del registro.

Según los roles que el administrador configuró:

- Si tu rol **no puede ver** un dato, aparece como ••••••.
- Un dato **obligatorio** que falta cuenta como un dato pendiente del registro: en terceros y productos se muestra como «Dato adicional: [nombre]» entre los datos que faltan, y el registro no queda listo para facturar hasta completarlo.

El sistema valida cada valor según su tipo: «Debe ser un número», «Fecha AAAA-MM-DD», «Máximo N caracteres», un valor que no está entre las opciones de la lista, una URL o un correo mal escritos.

## Cómo se editan

Si tu rol puede **actualizar** ese tipo de registro (por ejemplo «Actualizar tercero», `core.party.update`), los valores se editan en la misma pestaña:

1. Cambia los valores de los datos definidos o agrega, cambia y quita datos libres (**+ Agregar dato**, ✕).
2. Pulsa **Guardar datos adicionales** (o **Descartar cambios** para volver a lo guardado). El pie dice «Datos adicionales guardados» cuando termina.
3. Se guardan únicamente los datos adicionales: el resto del registro no cambia. Cada dato respeta lo que tu rol puede ingresar, editar y ver; los que no puedes ver siguen guardados y no se pierden.
4. Si el sistema rechaza un valor («Debe ser un número», «Máximo N caracteres»…), el motivo aparece bajo los botones y nada se guarda.
5. Si la acción es sensible en tu empresa, el sistema pide el código de 6 dígitos de tu app de autenticación y continúa con el guardado.

Sin permiso de actualizar, la pestaña es de consulta: ves los datos y sus valores, pero no se editan. Un dato obligatorio que completes con el guardado actualiza de inmediato los datos pendientes del registro.

## En los listados

Los datos adicionales que tu rol puede ver están disponibles en el selector **Columnas** y en el **Filtro avanzado** (marcados «(adicional)»), con las reglas propias de su tipo, pero no se muestran hasta que los eliges. La guía **Listados** explica ambos.
