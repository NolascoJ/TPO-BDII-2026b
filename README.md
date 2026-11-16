# FarmaRed: persistencia políglota

TPO de Base de Datos II (2C 2026). Backoffice de una red de farmacias con dos motores NoSQL:

- **MongoDB** (documental, replica set `rs0`): fuente de verdad. Persiste clientes, sucursales, farmacéuticos, proveedores, productos, lotes, recetas y ventas con sus ítems embebidos. Las escrituras (q13–q15) son transacciones multidocumento que registran eventos en una colección `outbox` (patrón transactional outbox).
- **Neo4j** (grafos): proyección de `Cliente`, `Receta`, `Venta`, `Farmaceutico`, `Sucursal` y `Producto` y sus relaciones, alimentada desde MongoDB por la outbox. Resuelve las consultas de recorrido e historial.

Implementado en Node.js 24 (ESM) con los drivers oficiales `mongodb` y `neo4j-driver`. Cada consulta está en `src/queries/qNN.js`.

## Entorno en Codespaces

Crear un codespace sobre `main`: **Code → Codespaces → Create codespace on main**.

`.devcontainer/devcontainer.json` levanta con `compose.yaml` los servicios `mongo`, `mongo-init` (inicializa el replica set), `neo4j` y `app` (`node:24.7.0`, donde corre la terminal). Las variables de conexión las define el servicio `app`, por lo que no hace falta `.env`. Al crearse el contenedor se ejecuta:

```bash
npm ci && npm run db:wait && npm run db:schema
```

`db:wait` espera al primario de MongoDB y a Neo4j; `db:schema` crea las colecciones con sus validadores `$jsonSchema` y los índices, incluidos los únicos sobre `dni` y `matricula`.

## Carga de datos

```bash
npm run data:check
```

```bash
npm run data:load
```

```bash
npm run graph:load
```

- `data:check`: parsea y valida los CSV (tipos, unicidad e integridad referencial) sin conectarse a las bases.
- `data:load`: carga en MongoDB, en una transacción, `data/*.csv` (datos provistos) y `data/adicionales/*.csv` (20 registros propios por archivo, IDs `AD-`). `detalle_ventas` se embebe en `ventas.items`.
- `graph:load`: crea las restricciones de unicidad de Neo4j y proyecta los datos de MongoDB. Con `-- --reset` vacía y reconstruye el grafo.

La carga es idempotente: hace upsert por ID con `$setOnInsert`, así que una segunda ejecución informa `"insertados": 0` y no altera stock, dispensas ni bajas posteriores. Las ventas importadas no descuentan stock (`stock_aplicado: true`, `origen: "importacion"`).

Totales esperados: 28 clientes, 25 sucursales, 27 farmacéuticos, 25 proveedores, 33 productos, 38 lotes, 29 recetas y 36 ventas con 42 ítems.

## Ejecución de las consultas

```bash
npm run query -- <qNN> '<parámetros JSON>'
```

Devuelve `{"ok": true, "consulta", "data"}`. Ante un error escribe `{"ok": false, "error": {"code", "message", "details"}}` en stderr y termina con código 1. Con `npm run -s` se omite el encabezado de npm.

| ID  | Motor   | Comando                                           |
| --- | ------- | ------------------------------------------------- |
| q01 | MongoDB | `npm run query -- q01`                            |
| q02 | MongoDB | `npm run query -- q02`                            |
| q03 | Neo4j   | `npm run query -- q03 '{"id_cliente":"AD-C004"}'` |
| q04 | Neo4j   | `npm run query -- q04`                            |
| q05 | Neo4j   | `npm run query -- q05`                            |
| q06 | MongoDB | `npm run query -- q06`                            |
| q07 | MongoDB | `npm run query -- q07`                            |
| q08 | MongoDB | `npm run query -- q08`                            |
| q09 | MongoDB | `npm run query -- q09`                            |
| q10 | Neo4j   | `npm run query -- q10 '{"id_sucursal":"S001"}'`   |
| q11 | MongoDB | `npm run query -- q11`                            |
| q12 | Neo4j   | `npm run query -- q12`                            |
| q13 | MongoDB | ver abajo                                         |
| q14 | MongoDB | ver abajo                                         |
| q15 | MongoDB | `npm run demo:q15` (ver abajo)                    |

q05, q06, q11 y q12 calculan sus intervalos con la fecha del sistema, en UTC.

### q13: ABM de clientes

`{"accion": "alta" | "modificar" | "baja", "id_cliente", "datos"}`. El alta requiere `nombre`, `apellido`, `dni`, `ciudad` y `provincia`. La modificación admite `email`, `telefono`, `ciudad`, `provincia`, `obra_social` y `nro_afiliado`. La baja es lógica (`activo: false`).

```bash
npm run query -- q13 '{"accion":"alta","id_cliente":"C900","datos":{"nombre":"Ana","apellido":"Prueba","dni":"40111222","ciudad":"Rosario","provincia":"Santa Fe","obra_social":"Sin cobertura"}}'
```

```bash
npm run query -- q13 '{"accion":"modificar","id_cliente":"C900","datos":{"email":"ana@example.com","obra_social":"OSDE","nro_afiliado":"OS-900100"}}'
```

```bash
npm run query -- q13 '{"accion":"baja","id_cliente":"C900"}'
```

Un alta con un DNI existente, aunque pertenezca a un cliente inactivo, devuelve `DNI_DUPLICADO`.

### q14: registro de venta

`{"id_venta", "id_cliente", "id_farmaceutico", "id_receta"?, "medio_pago", "items": [{"id_producto", "cantidad"}]}`. Valida cliente, farmacéutico de una sucursal `Farmacia`, productos y receta; calcula el total con los precios vigentes; actualiza la receta y ejecuta q15, todo en una transacción. `id_venta` es la clave de idempotencia: repetir el pedido devuelve `ya_registrada: true` sin volver a descontar.

```bash
npm run query -- q14 '{"id_venta":"V900","id_cliente":"C001","id_farmaceutico":"F001","medio_pago":"Débito","items":[{"id_producto":"PRD001","cantidad":2},{"id_producto":"PRD002","cantidad":1}]}'
```

```bash
npm run query -- q14 '{"id_venta":"V901","id_cliente":"C007","id_farmaceutico":"F001","id_receta":"RC006","medio_pago":"Efectivo","items":[{"id_producto":"PRD003","cantidad":1}]}'
```

Ejemplo de rechazo sin efectos persistidos (la receta pertenece a otro cliente, `RECETA_INVALIDA`):

```bash
npm run query -- q14 '{"id_venta":"V902","id_cliente":"C001","id_farmaceutico":"F001","id_receta":"RC006","medio_pago":"Efectivo","items":[{"id_producto":"PRD003","cantidad":1}]}'
```

### q15: descuento de stock por FEFO

`q15({db, session}, {id_venta})` descuenta, por vencimiento más próximo, los lotes vigentes de la sucursal de la venta y rechaza con `STOCK_INSUFICIENTE` si algún ítem no alcanza. Opera dentro de la transacción que abre quien la llama, por eso no se expone en `npm run query`: se ejecuta integrada en cada q14. Para ejecutarla de forma aislada (abre la transacción, muestra los lotes antes y después, el rechazo por stock insuficiente y el rechazo de un segundo descuento con `STOCK_YA_APLICADO`):

```bash
npm run demo:q15
```

### Sincronización del grafo

q13 y q14 escriben solo en MongoDB. Para que q03, q04, q05, q10 y q12 reflejen esos cambios, aplicar la outbox en Neo4j:

```bash
npm run outbox:procesar
```
