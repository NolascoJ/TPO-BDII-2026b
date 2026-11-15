# Datos adicionales

Cada CSV contiene 20 registros ficticios propios. Los nueve CSV originales de `data/` se conservan sin cambios. Los identificadores adicionales comienzan con `AD-`.

La carga completa produce 28 clientes, 25 sucursales, 27 farmacéuticos, 25 proveedores, 33 productos, 38 lotes, 29 recetas y 36 ventas. Los 42 detalles se embeben en las ventas: 22 originales y 20 adicionales.

Los lotes representan saldos disponibles. Las ventas importadas son históricas: su carga no descuenta stock ni vuelve a aplicar dispensas. Las recetas reflejan las dispensas de las ventas completadas. Las entidades actualmente inactivas pueden conservar ventas anteriores a su baja. La outbox se genera mediante operaciones, no mediante registros de relleno.

## Casos por consulta

| Consulta | Datos relevantes |
| --- | --- |
| q01 | `AD-P001` está activo y pertenece al proveedor inactivo `AD-PV019`. Los productos `AD-P008`, `AD-P016`, `AD-P019` y `AD-P020` están inactivos. |
| q02 | `AD-V015` a `AD-V018` están pendientes y mantienen sus relaciones con profesional y sucursal. |
| q03 | `AD-C004` tiene tres ventas con `AD-R001` y otra receta, `AD-R011`. |
| q04 | `AD-C004`, `AD-C006`, `AD-C007`, `AD-C009`, `AD-C010` y `AD-C013` tienen dos recetas. |
| q05 | `AD-F006` solo tiene una venta anulada y debe figurar con cero. `AD-V009` tiene 59 días y `AD-V011`, 61 días respecto de la fecha base. `AD-F007` es activo pero su venta de hace 61 días no cuenta. Las pendientes cuentan. |
| q06 | `AD-R004` a `AD-R007` tienen dispensas atrasadas; `AD-R008` y `AD-R009`, de hoy; `AD-R002` y `AD-R003`, futuras. `AD-R001` está completada y `AD-R010`, vencida. |
| q07 | Los cinco primeros adicionales son `AD-P004` (20), `AD-P009` (13), `AD-P007` (10), `AD-P014` (9) y `AD-P013` (8). Las 100 unidades pendientes y las 200 anuladas de `AD-P004` no se suman. |
| q08 | `AD-L007` a `AD-L010` tienen 0, 1, 49 y 50 unidades: solo los tres primeros entran. También hay lotes vencidos con saldo. |
| q09 | `AD-V001`, `AD-V002` y `AD-V003` valen 4999, 5000 y 5001. Entran `AD-V001`, la pendiente `AD-V015` y la antigua `AD-V018`; se excluye la anulada `AD-V019`. |
| q10 | `AD-S017` conserva la atención del farmacéutico inactivo `AD-F017`. Las droguerías `AD-S019` y `AD-S020` no tienen ventas. |
| q11 | `AD-V001` a `AD-V008` son completadas del mes de la fecha base. `AD-F001` suma 11999 en ese mes; `AD-F019`, hoy inactivo, conserva 1000 de ingresos. Pendientes y anuladas no suman ingresos. |
| q12 | `AD-C010` y `AD-C018` tienen compras de hace más de un año. `AD-C014`, `AD-C019` y `AD-C020` nunca compraron. `AD-C015` y `AD-C016` solo tienen anuladas, que el criterio actual excluye. |
| q13 | `AD-C014` permite demostrar una modificación y su evento. Los DNI son únicos. Las pruebas específicas cubren altas, bajas y duplicados. |
| q14/q15 | `AD-C013`, `AD-R004`, `AD-F001` y `AD-P009` permiten registrar una venta de 5 unidades. En la fecha base consume 3 de `AD-L002` y 2 de `AD-L003`; omite `AD-L001`, vencido, y los lotes de otras sucursales. |

## Generación y fechas

`manifest.json` registra la fecha base. Para reproducir los archivos:

```sh
npm run data:generate -- 2026-11-15
npm run data:check
```

El generador recibe una fecha explícita y siempre produce los mismos registros para esa fecha. Regenerar reemplaza solo los CSV adicionales y su manifiesto. No se ejecuta al cargar ni al iniciar el entorno.

Las consultas usan la fecha real del sistema, por lo que los resultados temporales cambian con el calendario. La prueba de integración fija el reloj a la fecha del manifiesto; la demo usa el reloj real. Si el stock del ejemplo vence, regenerar con una fecha actual y probar en una base nueva. Regenerar archivos no actualiza los documentos existentes: la carga preserva los datos ya insertados.

## Carga y ejecución

Con las variables de conexión configuradas:

```sh
npm run data:check
npm run data:load
npm run data:load
npm run graph:load
npm run demo:datos
```

La segunda carga debe informar cero insertados. `demo:datos` ejecuta q01–q12, una modificación con q13, una venta mediante q14/q15, rechazos sin efectos y el procesamiento de outbox. Usa una base temporal y nodos con prefijo propio; los elimina al terminar. Su salida JSON se puede redirigir a un archivo elegido por quien la ejecuta.

Los comandos `data:load` y `data:check` incluyen ambos conjuntos. `loadData(client, db)` y `buildDataset()` conservan el modo de originales para las pruebas existentes; `{ adicionales: true }` selecciona el conjunto completo. Las demos anteriores también conservan los originales.

## Verificación en Codespaces

El devcontainer instala dependencias, espera los motores y crea el esquema. Dentro del contenedor, ejecutar los comandos anteriores y:

```sh
npm test
npm run test:integration
npm run lint
npm run format:check
```

La suite de integración requiere un grafo de pruebas: algunos archivos lo vacían. Ejecutarla antes de cargar el grafo de presentación o usar una instancia dedicada. Después de la suite, `npm run graph:load` reconstruye la proyección desde MongoDB.

q15 recibe una transacción abierta por q14; no se invoca directamente desde `npm run query`. `demo:datos` verifica su integración y el rechazo del segundo descuento.
