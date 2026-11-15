import test from 'node:test';
import assert from 'node:assert/strict';
import { connectNeo4j } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureGraphSchema } from '../../src/graph/schema.js';
import {
  proyectarClientes,
  proyectarFarmaceuticos,
  proyectarProductos,
  proyectarRecetas,
  proyectarSucursales,
  proyectarVentas,
} from '../../src/graph/proyeccion.js';

test('Neo4j real: esquema del grafo idempotente', async (t) => {
  const database = config().neo4jDatabase;
  const driver = await connectNeo4j();
  try {
    // Correrlo dos veces no debe fallar ni duplicar restricciones
    await ensureGraphSchema(driver, database);
    await ensureGraphSchema(driver, database);

    await t.test('Existe una restricción de unicidad por etiqueta', async () => {
      const { records } = await driver.executeQuery(
        'SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties RETURN name, type, labelsOrTypes, properties',
        {},
        { database },
      );
      const porNombre = new Map(records.map((r) => [r.get('name'), r.toObject()]));
      const esperadas = {
        cliente_id_unico: ['Cliente', 'id_cliente'],
        receta_id_unico: ['Receta', 'id_receta'],
        venta_id_unico: ['Venta', 'id_venta'],
        farmaceutico_id_unico: ['Farmaceutico', 'id_farmaceutico'],
        sucursal_id_unico: ['Sucursal', 'id_sucursal'],
        producto_id_unico: ['Producto', 'id_producto'],
      };
      for (const [name, [label, property]] of Object.entries(esperadas)) {
        const constraint = porNombre.get(name);
        assert.ok(constraint, `Falta la restricción ${name}`);
        assert.equal(constraint.type, 'UNIQUENESS');
        assert.deepEqual(constraint.labelsOrTypes, [label]);
        assert.deepEqual(constraint.properties, [property]);
      }
    });

    await t.test('Existe el índice de fecha de ventas', async () => {
      const { records } = await driver.executeQuery(
        'SHOW INDEXES YIELD name, labelsOrTypes, properties WHERE name = $name RETURN labelsOrTypes, properties',
        { name: 'venta_fecha' },
        { database },
      );
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].get('labelsOrTypes'), ['Venta']);
      assert.deepEqual(records[0].get('properties'), ['fecha']);
    });

    await t.test('La unicidad rechaza un ID repetido', async () => {
      // ID que no puede chocar con datos reales; se borra al terminar
      const id = '__test_unicidad__';
      try {
        await driver.executeQuery('CREATE (:Cliente {id_cliente: $id})', { id }, { database });
        await assert.rejects(
          driver.executeQuery('CREATE (:Cliente {id_cliente: $id})', { id }, { database }),
          (error) => error.code === 'Neo.ClientError.Schema.ConstraintValidationFailed',
        );
      } finally {
        await driver.executeQuery(
          'MATCH (n:Cliente {id_cliente: $id}) DELETE n',
          { id },
          { database },
        );
      }
    });
  } finally {
    await driver.close();
  }
});

// Neo4j Community tiene una sola base: estas pruebas usan IDs con prefijo propio y los borran
// al terminar, sin tocar la proyección de trabajo
const P = 'T3PROY-';

const docs = {
  sucursal: (id, version = 1) => ({
    id_sucursal: P + id,
    nombre: `Sucursal ${id}`,
    tipo: 'Farmacia',
    direccion: 'Calle 1',
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
    telefono: null,
    activo: true,
    version,
  }),
  producto: (id) => ({
    id_producto: P + id,
    nombre: `Producto ${id}`,
    principio_activo: 'X',
    categoria: 'Analgésico',
    presentacion: 'Comprimidos',
    condicion_venta: 'Bajo receta',
    precio_unit: 1000,
    id_proveedor: 'PRV001',
    activo: true,
    version: 1,
  }),
  cliente: (id, version = 1, extra = {}) => ({
    id_cliente: P + id,
    nombre: 'Ana',
    apellido: 'Prueba',
    dni: `${P}${id}`,
    email: null,
    telefono: null,
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
    obra_social: 'OSDE',
    nro_afiliado: 'OS-1',
    activo: true,
    version,
    ...extra,
  }),
  farmaceutico: (id, sucursal, version = 1) => ({
    id_farmaceutico: P + id,
    nombre: 'Juan',
    apellido: 'Prueba',
    matricula: P + id,
    cargo: 'Farmacéutico',
    id_sucursal: P + sucursal,
    activo: true,
    version,
  }),
  receta: (id, cliente, version, extra = {}) => ({
    id_receta: P + id,
    id_cliente: P + cliente,
    medico: 'Dra. Prueba',
    matricula_medico: 'MP-1',
    fecha_emision: new Date('2026-09-01T00:00:00Z'),
    tipo: 'Tratamiento prolongado',
    dispensas_autorizadas: 3,
    dispensas_realizadas: 1,
    proxima_dispensa: new Date('2026-10-01T00:00:00Z'),
    estado: 'Vigente',
    version,
    ...extra,
  }),
  venta: (id, { cliente, farmaceutico, sucursal, receta = null, productos }) => ({
    id_venta: P + id,
    id_cliente: P + cliente,
    id_farmaceutico: P + farmaceutico,
    id_sucursal: P + sucursal,
    id_receta: receta && P + receta,
    fecha: new Date('2026-10-02T15:04:05Z'),
    tipo: receta ? 'Con receta' : 'Venta libre',
    medio_pago: 'Efectivo',
    total: 1000 * productos.length,
    estado: 'Completada',
    stock_aplicado: true,
    origen: 'operacion',
    version: 1,
    items: productos.map((producto, i) => ({
      id_detalle: `${P}${id}-${i + 1}`,
      id_producto: P + producto,
      cantidad: 1,
      precio_unit: 1000,
    })),
  }),
};

test('Neo4j real: proyección con guardia de versión, relaciones y dependencias', async (t) => {
  const database = config().neo4jDatabase;
  const driver = await connectNeo4j();
  const escribir = async (fn) => {
    const session = driver.session({ database });
    try {
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  };
  const leer = async (cypher, params = {}) =>
    (await driver.executeQuery(cypher, params, { database })).records.map((r) => r.toObject());
  const limpiar = () =>
    driver.executeQuery(
      `MATCH (n) WHERE any(k IN ['id_cliente','id_sucursal','id_producto','id_farmaceutico','id_receta','id_venta']
         WHERE n[k] STARTS WITH $p) DETACH DELETE n`,
      { p: P },
      { database },
    );

  try {
    await ensureGraphSchema(driver, database);
    await limpiar();

    await escribir(async (tx) => {
      await proyectarSucursales(tx, [docs.sucursal('S1'), docs.sucursal('S2')]);
      await proyectarProductos(tx, [docs.producto('P1'), docs.producto('P2')]);
      await proyectarClientes(tx, [docs.cliente('C1')]);
      await proyectarFarmaceuticos(tx, [docs.farmaceutico('F1', 'S1')]);
      await proyectarRecetas(tx, [docs.receta('R1', 'C1', 1)]);
    });
    const venta = docs.venta('V1', {
      cliente: 'C1',
      farmaceutico: 'F1',
      sucursal: 'S1',
      receta: 'R1',
      productos: ['P1', 'P2'],
    });
    const primera = await escribir((tx) => proyectarVentas(tx, [venta]));
    assert.deepEqual(primera, [{ id: P + 'V1', aplicado: true }]);

    const relacionesVenta = () =>
      leer(
        `MATCH (v:Venta {id_venta: $id})
         RETURN
           COUNT { (:Cliente)-[:REALIZO]->(v) } AS realizo,
           COUNT { (v)-[:ATENDIDA_POR]->(:Farmaceutico) } AS atendida,
           [(v)-[:REGISTRADA_EN]->(s:Sucursal) | s.id_sucursal] AS sucursales,
           COUNT { (v)-[:USA_RECETA]->(:Receta) } AS receta,
           [(v)-[i:INCLUYE]->(p:Producto) | p.id_producto + ':' + toString(i.cantidad)] AS items,
           v.fecha AS fecha`,
        { id: P + 'V1' },
      );

    await t.test('La venta queda con todas sus relaciones y la fecha en UTC', async () => {
      const [r] = await relacionesVenta();
      assert.equal(r.realizo.toNumber(), 1);
      assert.equal(r.atendida.toNumber(), 1);
      assert.deepEqual(r.sucursales, [P + 'S1']);
      assert.equal(r.receta.toNumber(), 1);
      assert.deepEqual(r.items.sort(), [`${P}P1:1`, `${P}P2:1`]);
      assert.equal(r.fecha.toStandardDate().toISOString(), '2026-10-02T15:04:05.000Z');
    });

    await t.test('Repetir la venta (misma versión) no aplica ni duplica relaciones', async () => {
      const antes = await relacionesVenta();
      const segunda = await escribir((tx) => proyectarVentas(tx, [venta]));
      assert.deepEqual(segunda, [{ id: P + 'V1', aplicado: false }]);
      assert.deepEqual(await relacionesVenta(), antes);
    });

    await t.test('Una receta más nueva se aplica y una vieja no la revierte', async () => {
      const completada = docs.receta('R1', 'C1', 2, {
        dispensas_realizadas: 2,
        proxima_dispensa: null,
        estado: 'Completada',
      });
      assert.deepEqual(await escribir((tx) => proyectarRecetas(tx, [completada])), [
        { id: P + 'R1', aplicado: true },
      ]);
      assert.deepEqual(await escribir((tx) => proyectarRecetas(tx, [docs.receta('R1', 'C1', 1)])), [
        { id: P + 'R1', aplicado: false },
      ]);
      const [r] = await leer(
        `MATCH (c:Cliente)-[:TIENE_RECETA]->(n:Receta {id_receta: $id})
         RETURN n.estado AS estado, n.version AS version, n.proxima_dispensa AS proxima,
                count(c) AS duenos`,
        { id: P + 'R1' },
      );
      assert.equal(r.estado, 'Completada');
      assert.equal(r.version.toNumber(), 2);
      assert.equal(r.proxima, null);
      assert.equal(r.duenos.toNumber(), 1);
    });

    await t.test('Baja lógica: el cliente sigue con su historia', async () => {
      await escribir((tx) => proyectarClientes(tx, [docs.cliente('C1', 2, { activo: false })]));
      const [r] = await leer(
        `MATCH (c:Cliente {id_cliente: $id})
         RETURN c.activo AS activo, COUNT { (c)-[:REALIZO]->() } AS ventas`,
        { id: P + 'C1' },
      );
      assert.equal(r.activo, false);
      assert.equal(r.ventas.toNumber(), 1);
    });

    await t.test('Cambio de sucursal: reemplaza TRABAJA_EN y no mueve la venta', async () => {
      await escribir((tx) => proyectarFarmaceuticos(tx, [docs.farmaceutico('F1', 'S2', 2)]));
      const [r] = await leer(
        `MATCH (f:Farmaceutico {id_farmaceutico: $f})
         MATCH (v:Venta {id_venta: $v})-[:REGISTRADA_EN]->(hist:Sucursal)
         RETURN [(f)-[:TRABAJA_EN]->(s) | s.id_sucursal] AS actual, hist.id_sucursal AS historica`,
        { f: P + 'F1', v: P + 'V1' },
      );
      assert.deepEqual(r.actual, [P + 'S2']);
      assert.equal(r.historica, P + 'S1');
    });

    await t.test('Dependencia faltante: error y nada escrito', async () => {
      const huerfana = docs.venta('V2', {
        cliente: 'NO-EXISTE',
        farmaceutico: 'F1',
        sucursal: 'S1',
        productos: ['P1', 'P-NO-EXISTE'],
      });
      await assert.rejects(
        escribir((tx) => proyectarVentas(tx, [huerfana])),
        (error) =>
          error.code === 'DEPENDENCIA_FALTANTE' &&
          error.details.faltantes.Cliente[0] === P + 'NO-EXISTE' &&
          error.details.faltantes.Producto[0] === P + 'P-NO-EXISTE',
      );
      const r = await leer('MATCH (v:Venta {id_venta: $id}) RETURN v', { id: P + 'V2' });
      assert.equal(r.length, 0);
    });

    await t.test('Venta libre: sin USA_RECETA', async () => {
      const libre = docs.venta('V3', {
        cliente: 'C1',
        farmaceutico: 'F1',
        sucursal: 'S1',
        productos: ['P1'],
      });
      await escribir((tx) => proyectarVentas(tx, [libre]));
      const [r] = await leer(
        'MATCH (v:Venta {id_venta: $id}) RETURN COUNT { (v)-[:USA_RECETA]->() } AS recetas',
        { id: P + 'V3' },
      );
      assert.equal(r.recetas.toNumber(), 0);
    });
  } finally {
    await limpiar();
    await driver.close();
  }
});
