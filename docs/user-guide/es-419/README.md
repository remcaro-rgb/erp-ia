
# Guías de usuario de ERP-IA

Guías para quien usa ERP-IA todos los días, en español latinoamericano. El asistente de ayuda las lee para responder preguntas y llevarte a la pantalla correcta.

- [Primeros pasos en ERP-IA](inicio.md): qué es el sistema, cómo empezar y la pantalla de Inicio (indicadores, recomendaciones, tarjetas que se mueven y cambian de tamaño).
- [Ingresar y verificación en dos pasos](ingreso-y-2fa.md): ingresar, recordar el dispositivo, activar el código de 6 dígitos y confirmar acciones sensibles.
- [Moverse por el sistema](navegacion.md): empresa, módulos, pestañas, ⌘K, tema claro u oscuro, duplicar un registro y llenar formularios con el teclado.
- [Terceros: clientes, proveedores y empleados](terceros.md): datos DIAN, correos, teléfono y «Listo para facturar».
- [Contactos de un tercero](contactos.md): las personas de contacto de cada tercero.
- [Productos: bienes y servicios](productos.md): datos DIAN, impuestos heredados y fotos.
- [Categorías de productos](categorias.md): impuestos por defecto para los productos nuevos.
- [Archivos adjuntos](archivos.md): arrastrar y soltar, etiquetas, archivos obligatorios y quitar con confirmación.
- [Datos adicionales](datos-adicionales.md): los campos propios que define el administrador de tu empresa.
- [Listados: ordenar, filtrar y guardar vistas](listados.md): orden, filtros, columnas (elegirlas y moverlas), enlaces a registros, filtro avanzado con Y/O, lupa y vistas guardadas.
- [Exportar un listado a PDF, Excel o CSV](exportar.md): llevarte lo que ves a un archivo.
- [Importar terceros, productos o categorías desde Excel o CSV](importar.md): cargar muchos registros con una plantilla.
- [Pedir ayuda: tickets de soporte](soporte.md): reportar un problema o hacer una pregunta.
- [El asistente: preguntar, pedir acciones y confirmar](asistente.md): consultar datos, tarjetas de confirmación, código de verificación y qué hacer con los resultados.
- [Administración de la empresa](administracion.md): roles, usuarios (editar y desactivar), permisos y visibilidad de campos con cambios en lote, procesos sensibles, módulos, archivos obligatorios, datos adicionales, verificadores, uso de IA y auditoría con el antes y el después de cada cambio.

## Contabilidad

- [Plan de cuentas](contabilidad/plan-de-cuentas.md): el PUC en Tabla o Árbol, crear cuentas auxiliares, saldos y desactivar.
- [Comprobantes contables y Fuentes](contabilidad/comprobantes.md): crear un comprobante manual, plantillas, aprobación por otra persona, reversar, anular y las fuentes.
- [Consulta de movimientos](contabilidad/consulta-de-movimientos.md): filtrar, ordenar por varias columnas, agrupar y totalizar las líneas del libro, guardar y exportar.
- [Centros de costo](contabilidad/centros-de-costo.md): dónde se gastó o se ganó, en árbol, con su resultado por período.
- [Auxiliares abiertos e ítems](contabilidad/auxiliares-abiertos-e-items.md): las dos dimensiones opcionales y cómo encenderlas.
- [Unidades de negocio](contabilidad/unidades-de-negocio.md): medir una línea de la empresa, desde el encabezado del comprobante.
- [Períodos y cierre](contabilidad/periodos-y-cierre.md): cómo cierro el mes, las verificaciones, reabrir y cerrar el año.
- [Controles contables](contabilidad/controles-y-cierre.md): aprobación, reversión automática, conciliación de control, cuenta transitoria y auditoría de comprobantes manuales.
- [Seguridad por cuenta](contabilidad/seguridad-por-cuenta.md): restringir cuentas y qué ve quien no tiene acceso.
- [Informes contables](contabilidad/informes.md): balance de prueba, estados financieros, libro diario, auxiliares, exportar y guardar parámetros.
- [Cartera y cuentas por pagar por edades](contabilidad/cartera-por-edades.md): quién debe, desde cuándo, por rangos de días.
- [Información exógena](contabilidad/exogena.md): asociar cuentas a conceptos, el informe por formato y la exportación.
- [Reglas contables](contabilidad/reglas-contables.md): configurar la contabilidad, mapeo de cuentas, reglas, probarlas y la configuración.
- [Pendientes de contabilizar](contabilidad/pendientes-de-contabilizar.md): qué hacer cuando un documento no se pudo contabilizar.

## Actualizar las capturas de pantalla

Las imágenes de `contabilidad/img/` las genera `apps/web/guide-shots/accounting.shots.ts` (una prueba por imagen) sobre la empresa demo, con Laura, tema claro y la fecha fija del 30 de octubre de 2026. No forman parte de `pnpm -F web e2e`, así que la integración continua nunca las reescribe.

```bash
pnpm db:reset && DEMO_SEED=1 pnpm db:seed
```

```bash
E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web guide:shots
```

Con la aplicación corriendo en el puerto 3100. Los estados que la demo no trae (un borrador con líneas, un pendiente de contabilizar) los crea y los borra la propia prueba. Revisa cada imagen: debe mostrar lo que dice su texto alternativo, en español, sin la marca del servidor de desarrollo.
