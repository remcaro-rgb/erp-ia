---
title: "Centros de costo"
routes:
  - /accounting/cost-centers
processes:
  - accounting.cost_center.create
  - accounting.cost_center.update
  - accounting.cost_center.consult
---

# Centros de costo

Un **centro de costo** responde «¿dónde se gastó o se ganó?»: una sede, un proyecto, un área. Se asigna a cada línea de un comprobante y permite ver el estado de resultados por centro. Entra por **Contabilidad › Maestros › Centros de costo**.

[Captura: Centros de costo en vista Árbol]

## Tabla o Árbol

Como en todos los maestros jerárquicos, el interruptor **Vista** ofrece **Tabla** y **Árbol** y recuerda tu elección.

- **Tabla**: Código, Descripción, Padre, Tipo (**Grupo** u hoja), Activo y la columna **Resultado** del período que elijas en **Período**, la misma cifra del Árbol con los centros hijos incluidos. Se ordena, se filtra y sale en la exportación.
- **Árbol**: los centros anidados, con el **Resultado** del período que elijas junto a cada nodo, y a la derecha lo que hay **Dentro de** el nodo seleccionado.

## Crear un centro de costo

1. Si quieres que cuelgue de otro, selecciónalo en el Árbol.
2. Pulsa **Nuevo**. El diálogo dice **Bajo** qué nodo se creará (o **Nivel superior**).
3. Escribe **Código** y **Descripción**, elige el **Tipo** (un **Grupo** agrupa a otros; una hoja recibe movimientos) y pulsa **Crear**.

Solo las hojas reciben líneas de comprobantes; un grupo suma lo de sus hijos.

## Abrir un centro

Sus pestañas: **Datos**, **Resultados** (ingresos, gastos y resultado por período), **Movimientos**, **Datos adicionales** y **Archivos**.

## Usarlo

- En un comprobante, la columna **Centro de costo** de la línea.
- En una cuenta que **Exige centro de costo**, la línea no se contabiliza sin él.
- En los informes: **Estado de resultados por centro de costo** (una columna por centro) y **Auxiliar por dimensión analítica** (guía **Informes**).
- En **Movimientos**: filtra o agrupa por **Centro de costo** (guía **Consulta de movimientos**).

## Desactivar

En **Datos**, quita **Activo**. Deja de ofrecerse en las líneas nuevas, pero conserva su historia.
