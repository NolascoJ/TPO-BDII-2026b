import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo, connectNeo4j } from '../../src/db/connections.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { q14 } from '../../src/queries/q14.js';
import { cargarGrafo, vaciarGrafo } from '../../src/graph/bootstrap.js';
import { aplicarEvento } from '../../src/graph/eventos.js';
import { q03 } from '../../src/queries/q03.js';
import { q04 } from '../../src/queries/q04.js';
import { q05 } from '../../src/queries/q05.js';
import { q10 } from '../../src/queries/q10.js';
import { q12 } from '../../src/queries/q12.js';
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

// Esta prueba carga el dataset real, con los mismos IDs que la proyección de trabajo: como
// Neo4j Community tiene una sola base, vacía el grafo antes y después. Para volver a tener la
// proyección de trabajo: npm run graph:load
test('Neo4j real: carga inicial desde MongoDB, idempotente y con entidades sin ventas', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const database = settings.neo4jDatabase;
  const { client, db } = await connectMongo(settings);
  const driver = await connectNeo4j(settings);
  const contexto = { db, driver, neo4jDatabase: database };
  const leer = async (cypher, params = {}) =>
    (await driver.executeQuery(cypher, params, { database })).records.map((r) => r.toObject());
  const conteos = async () => {
    const [r] = await leer(`
      RETURN
        COUNT { (:Sucursal) } AS sucursales, COUNT { (:Producto) } AS productos,
        COUNT { (:Cliente) } AS clientes, COUNT { (:Farmaceutico) } AS farmaceuticos,
        COUNT { (:Receta) } AS recetas, COUNT { (:Venta) } AS ventas,
        COUNT { ()-[:TRABAJA_EN]->() } AS trabaja_en, COUNT { ()-[:TIENE_RECETA]->() } AS tiene_receta,
        COUNT { ()-[:REALIZO]->() } AS realizo, COUNT { ()-[:ATENDIDA_POR]->() } AS atendida_por,
        COUNT { ()-[:REGISTRADA_EN]->() } AS registrada_en, COUNT { ()-[:USA_RECETA]->() } AS usa_receta,
        COUNT { ()-[:INCLUYE]->() } AS incluye`);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toNumber()]));
  };

  try {
    await ensureSchema(db);
    await loadData(client, db);
    // Una venta creada por q14 (origen operacion) también tiene que entrar en la carga
    await q14(
      { client, db },
      {
        id_venta: 'V-T3-BOOT',
        id_cliente: 'C005',
        id_farmaceutico: 'F001',
        medio_pago: 'Efectivo',
        items: [{ id_producto: 'PRD001', cantidad: 2 }],
      },
    );

    const primera = await cargarGrafo(contexto, { reset: true });
    const esperado = {
      sucursales: 5,
      productos: 13,
      clientes: 8,
      farmaceuticos: 7,
      recetas: 9,
      ventas: 17,
    };
    for (const [coleccion, cantidad] of Object.entries(esperado)) {
      assert.deepEqual(primera.entidades[coleccion], {
        fuente: cantidad,
        aplicados: cantidad,
        sin_cambios: 0,
      });
    }
    const despuesPrimera = await conteos();

    await t.test('Nodos y relaciones esperados con el dataset provisto más la venta de q14', () => {
      assert.deepEqual(despuesPrimera, {
        ...esperado,
        trabaja_en: 7,
        tiene_receta: 9,
        realizo: 17,
        atendida_por: 17,
        registrada_en: 17,
        usa_receta: 10,
        incluye: 23,
      });
    });

    await t.test('Repetir la carga no aplica ni duplica nada', async () => {
      const segunda = await cargarGrafo(contexto);
      for (const [coleccion, cantidad] of Object.entries(esperado)) {
        assert.deepEqual(segunda.entidades[coleccion], {
          fuente: cantidad,
          aplicados: 0,
          sin_cambios: cantidad,
        });
      }
      assert.deepEqual(await conteos(), despuesPrimera);
    });

    await t.test('Incluye entidades sin ventas y conserva la atención de inactivos', async () => {
      const [r] = await leer(`
        MATCH (c8:Cliente {id_cliente: 'C008'}), (f7:Farmaceutico {id_farmaceutico: 'F007'})
        MATCH (:Cliente {id_cliente: 'C004'})-[:REALIZO]->(v1:Venta {id_venta: 'V001'})
              -[:ATENDIDA_POR]->(f4:Farmaceutico)
        MATCH (v1)-[:REGISTRADA_EN]->(s:Sucursal)
        RETURN c8.activo AS c8_activo, COUNT { (c8)-[:REALIZO]->() } AS c8_ventas,
               COUNT { (f7)<-[:ATENDIDA_POR]-() } AS f7_ventas,
               f4.id_farmaceutico AS f4, f4.activo AS f4_activo, s.id_sucursal AS sucursal`);
      assert.equal(r.c8_activo, false);
      assert.equal(r.c8_ventas.toNumber(), 0);
      assert.equal(r.f7_ventas.toNumber(), 0);
      assert.equal(r.f4, 'F004');
      assert.equal(r.f4_activo, false);
      assert.equal(r.sucursal, 'S002');
    });

    await t.test('La venta de q14 conserva fecha con hora, total y precio histórico', async () => {
      const venta = await db.collection('ventas').findOne({ id_venta: 'V-T3-BOOT' });
      const [r] = await leer(
        `MATCH (v:Venta {id_venta: 'V-T3-BOOT'})-[i:INCLUYE]->(p:Producto)
         RETURN v.fecha AS fecha, v.total AS total, v.origen AS origen,
                i.precio_unit AS precio, p.id_producto AS producto`,
      );
      assert.equal(r.fecha.toStandardDate().getTime(), venta.fecha.getTime());
      assert.equal(r.total.toNumber(), 5600);
      assert.equal(r.origen, 'operacion');
      assert.equal(r.precio.toNumber(), 2800);
      assert.equal(r.producto, 'PRD001');
    });

    await t.test('Un cambio en MongoDB con versión mayor entra en la siguiente carga', async () => {
      await db
        .collection('clientes')
        .updateOne(
          { id_cliente: 'C001' },
          { $set: { telefono: '1100000000' }, $inc: { version: 1 } },
        );
      const tercera = await cargarGrafo(contexto);
      assert.equal(tercera.entidades.clientes.aplicados, 1);
      const [r] = await leer(
        "MATCH (c:Cliente {id_cliente: 'C001'}) RETURN c.telefono AS tel, c.version AS v",
      );
      assert.equal(r.tel, '1100000000');
      assert.equal(r.v.toNumber(), 2);
    });
  } finally {
    await vaciarGrafo(driver, database);
    await db.dropDatabase();
    await client.close();
    await driver.close();
  }
});

// Igual que la carga inicial: usa los IDs reales, así que vacía el grafo antes y después
test('Neo4j real: aplicación de eventos de la outbox', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const database = settings.neo4jDatabase;
  const { client, db } = await connectMongo(settings);
  const driver = await connectNeo4j(settings);
  const aplicar = (evento) => aplicarEvento(driver, database, evento);
  const leer = async (cypher, params = {}) =>
    (await driver.executeQuery(cypher, params, { database })).records.map((r) => r.toObject());
  const evento = (tipo_entidad, contenido, idCampo) => ({
    id_evento: `${tipo_entidad}:${contenido[idCampo]}:${contenido.version}`,
    tipo_entidad,
    id_entidad: contenido[idCampo],
    version: contenido.version,
    contenido,
  });
  const totalRelaciones = async () =>
    (await leer('MATCH ()-[r]->() RETURN count(r) AS n'))[0].n.toNumber();

  try {
    await ensureSchema(db);
    await loadData(client, db);
    await cargarGrafo({ db, driver, neo4jDatabase: database }, { reset: true });
    const { _id, ...recetaV1 } = await db.collection('recetas').findOne({ id_receta: 'RC004' });

    // Venta real con receta (RC004 pasa de 1/3 a 2/3): q14 deja los eventos en la outbox
    await q14(
      { client, db },
      {
        id_venta: 'V-T3-EV',
        id_cliente: 'C006',
        id_farmaceutico: 'F001',
        id_receta: 'RC004',
        medio_pago: 'Obra social',
        items: [{ id_producto: 'PRD003', cantidad: 1 }],
      },
    );
    const pendientes = await db
      .collection('outbox')
      .find({ estado: 'Pendiente' })
      .sort({ creado_en: 1, id_evento: 1 })
      .toArray();

    await t.test('Los eventos de q14 se aplican y la venta aparece en el grafo', async () => {
      assert.deepEqual(pendientes.map((e) => e.id_evento).sort(), [
        'receta:RC004:2',
        'venta:V-T3-EV:1',
      ]);
      for (const e of pendientes) {
        assert.deepEqual(await aplicar(e), { estado: 'aplicado' });
      }
      const [r] = await leer(`
        MATCH (:Cliente {id_cliente: 'C006'})-[:REALIZO]->(v:Venta {id_venta: 'V-T3-EV'})
              -[:USA_RECETA]->(rc:Receta {id_receta: 'RC004'})
        MATCH (v)-[:REGISTRADA_EN]->(s:Sucursal)
        RETURN rc.dispensas_realizadas AS realizadas, rc.version AS version,
               rc.proxima_dispensa IS NOT NULL AS con_proxima, s.id_sucursal AS sucursal,
               COUNT { (v)-[:INCLUYE]->(:Producto {id_producto: 'PRD003'}) } AS items`);
      assert.equal(r.realizadas.toNumber(), 2);
      assert.equal(r.version.toNumber(), 2);
      assert.equal(r.con_proxima, true);
      assert.equal(r.sucursal, 'S001');
      assert.equal(r.items.toNumber(), 1);
    });

    await t.test('Repetir los eventos da obsoleto y no duplica nada', async () => {
      const antes = await totalRelaciones();
      for (const e of pendientes) {
        assert.deepEqual(await aplicar(e), { estado: 'obsoleto' });
      }
      assert.equal(await totalRelaciones(), antes);
    });

    await t.test('Un evento viejo de receta no revierte el estado más reciente', async () => {
      assert.deepEqual(await aplicar(evento('receta', recetaV1, 'id_receta')), {
        estado: 'obsoleto',
      });
      const [r] = await leer(
        "MATCH (rc:Receta {id_receta: 'RC004'}) RETURN rc.dispensas_realizadas AS n",
      );
      assert.equal(r.n.toNumber(), 2);
    });

    await t.test('Dependencia faltante: error reintentable, y se resuelve en orden', async () => {
      const ventaQ14 = pendientes.find((e) => e.tipo_entidad === 'venta').contenido;
      const huerfana = evento(
        'venta',
        {
          ...ventaQ14,
          id_venta: 'V-T3-HUERF',
          id_cliente: 'C-T3',
          id_receta: null,
          tipo: 'Venta libre',
          items: [{ ...ventaQ14.items[0], id_detalle: 'V-T3-HUERF-01' }],
        },
        'id_venta',
      );
      await assert.rejects(
        aplicar(huerfana),
        (error) =>
          error.code === 'DEPENDENCIA_FALTANTE' &&
          error.details.reintentable === true &&
          error.details.faltantes.Cliente[0] === 'C-T3',
      );
      assert.equal((await leer("MATCH (v:Venta {id_venta: 'V-T3-HUERF'}) RETURN v")).length, 0);

      // Llega el evento del cliente (como lo generaría q13) y el reintento de la venta funciona
      const { _id: _c, ...base } = await db.collection('clientes').findOne({ id_cliente: 'C005' });
      const nuevo = { ...base, id_cliente: 'C-T3', dni: '99999999', version: 1 };
      assert.deepEqual(await aplicar(evento('cliente', nuevo, 'id_cliente')), {
        estado: 'aplicado',
      });
      assert.deepEqual(await aplicar(huerfana), { estado: 'aplicado' });
    });

    await t.test('Cliente modificado y dado de baja: se proyecta sin perder ventas', async () => {
      const { _id: _c, ...c006 } = await db.collection('clientes').findOne({ id_cliente: 'C006' });
      const baja = { ...c006, telefono: '1100000000', activo: false, version: 2 };
      assert.deepEqual(await aplicar(evento('cliente', baja, 'id_cliente')), {
        estado: 'aplicado',
      });
      const [r] = await leer(`
        MATCH (c:Cliente {id_cliente: 'C006'})
        RETURN c.activo AS activo, c.telefono AS tel, COUNT { (c)-[:REALIZO]->() } AS ventas`);
      assert.equal(r.activo, false);
      assert.equal(r.tel, '1100000000');
      assert.equal(r.ventas.toNumber(), 5);
    });

    await t.test('Farmacéutico que cambia de sucursal: sus ventas no se mueven', async () => {
      const { _id: _f, ...f001 } = await db
        .collection('farmaceuticos')
        .findOne({ id_farmaceutico: 'F001' });
      const cambio = { ...f001, id_sucursal: 'S002', version: 2 };
      assert.deepEqual(await aplicar(evento('farmaceutico', cambio, 'id_farmaceutico')), {
        estado: 'aplicado',
      });
      const [r] = await leer(`
        MATCH (f:Farmaceutico {id_farmaceutico: 'F001'})
        RETURN [(f)-[:TRABAJA_EN]->(s) | s.id_sucursal] AS actual,
               [(f)<-[:ATENDIDA_POR]-(v)-[:REGISTRADA_EN]->(s) | s.id_sucursal] AS historicas`);
      assert.deepEqual(r.actual, ['S002']);
      assert.ok(r.historicas.length > 0);
      assert.ok(r.historicas.every((s) => s === 'S001'));
    });

    await t.test('Sucursal dada de baja', async () => {
      const { _id: _s, ...s004 } = await db
        .collection('sucursales')
        .findOne({ id_sucursal: 'S004' });
      assert.deepEqual(
        await aplicar(evento('sucursal', { ...s004, activo: false, version: 2 }, 'id_sucursal')),
        { estado: 'aplicado' },
      );
      const [r] = await leer("MATCH (s:Sucursal {id_sucursal: 'S004'}) RETURN s.activo AS activo");
      assert.equal(r.activo, false);
    });

    await t.test('Evento inválido: error no reintentable y sin escritura', async () => {
      const valido = pendientes.find((e) => e.tipo_entidad === 'receta');
      const invalidos = [
        { ...valido, tipo_entidad: 'stock' },
        { ...valido, id_entidad: 'RC999' },
        { ...valido, version: 9 },
        { ...valido, contenido: null },
      ];
      const antes = await totalRelaciones();
      for (const e of invalidos) {
        await assert.rejects(
          aplicar(e),
          (error) => error.code === 'EVENTO_INVALIDO' && error.details.reintentable === false,
        );
      }
      assert.equal(await totalRelaciones(), antes);
    });
  } finally {
    await vaciarGrafo(driver, database);
    await db.dropDatabase();
    await client.close();
    await driver.close();
  }
});

// Consultas del grafo con el dataset provisto. Las fechas de ventas y recetas se corren para
// que "hoy" equivalga al 15/11/2026: así los resultados no cambian con el calendario.
// Igual que las anteriores, vacía el grafo antes y después.
test('Neo4j real: consultas q03, q04, q05, q10 y q12 sobre el dataset provisto', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const database = settings.neo4jDatabase;
  const { client, db } = await connectMongo(settings);
  const driver = await connectNeo4j(settings);
  const ctx = { driver, neo4jDatabase: database };

  try {
    await ensureSchema(db);
    await loadData(client, db);
    const hoy = new Date();
    const desplazamiento =
      Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()) - Date.UTC(2026, 10, 15);
    const correr = (campo) => ({ [campo]: { $add: ['$' + campo, desplazamiento] } });
    await db.collection('ventas').updateMany({}, [{ $set: correr('fecha') }]);
    await db
      .collection('recetas')
      .updateMany({}, [{ $set: { ...correr('fecha_emision'), ...correr('proxima_dispensa') } }]);
    await cargarGrafo({ db, driver, neo4jDatabase: database }, { reset: true });

    await t.test(
      'q03: historial de C006 en orden cronológico, receta antes que venta',
      async () => {
        const { cliente, historial } = await q03(ctx, { id_cliente: 'C006' });
        assert.equal(cliente.id_cliente, 'C006');
        assert.deepEqual(
          historial.map((e) => e.id_venta ?? e.id_receta),
          ['RC003', 'V006', 'V007', 'RC004', 'V008', 'V016'],
        );
        assert.ok(historial.every((e, i) => i === 0 || historial[i - 1].fecha <= e.fecha));
        const v006 = historial.find((e) => e.id_venta === 'V006');
        assert.equal(v006.evento, 'venta');
        assert.equal(v006.id_receta, 'RC003');
        assert.equal(v006.farmaceutico.id_farmaceutico, 'F002');
        assert.equal(v006.sucursal.id_sucursal, 'S001');
        assert.equal(v006.items.length, 2);
        assert.equal(
          v006.items.reduce((s, i) => s + i.cantidad * i.precio_unit, 0),
          v006.total,
        );
        assert.ok(v006.fecha instanceof Date);
        assert.equal(historial.find((e) => e.id_venta === 'V016').id_receta, null);
        assert.equal(historial[0].evento, 'receta');
        assert.equal(historial[0].dispensas_realizadas, 2);
      },
    );

    await t.test('q03: cliente sin movimientos, inexistente y sin parámetro', async () => {
      assert.deepEqual((await q03(ctx, { id_cliente: 'C008' })).historial, []);
      await assert.rejects(q03(ctx, { id_cliente: 'C999' }), { code: 'CLIENTE_INVALIDO' });
      await assert.rejects(q03(ctx, {}), { code: 'PARAMETROS_INVALIDOS' });
    });

    await t.test('q04: clientes con más de una receta', async () => {
      assert.deepEqual(
        (await q04(ctx)).map((c) => [c.id_cliente, c.cantidad_recetas, c.recetas]),
        [
          ['C001', 2, ['RC001', 'RC008']],
          ['C002', 2, ['RC005', 'RC009']],
          ['C006', 2, ['RC003', 'RC004']],
        ],
      );
    });

    await t.test(
      'q05: activos con ventas no anuladas de 60 días, incluidos los de cero',
      async () => {
        const { farmaceuticos } = await q05(ctx);
        assert.deepEqual(
          farmaceuticos.map((f) => [f.id_farmaceutico, f.ventas]),
          [
            ['F005', 3],
            ['F002', 2],
            ['F001', 1],
            ['F003', 1],
            ['F006', 1],
            ['F007', 0],
          ],
        );
      },
    );

    await t.test('q10: S002 incluye la atención de F004, hoy inactivo', async () => {
      const { sucursal, clientes } = await q10(ctx, { id_sucursal: 'S002' });
      assert.equal(sucursal.id_sucursal, 'S002');
      assert.deepEqual(
        clientes.map((c) => [
          c.id_cliente,
          c.farmaceuticos.map((f) => [f.id_farmaceutico, f.activo]),
        ]),
        [
          ['C001', [['F003', true]]],
          ['C004', [['F004', false]]],
        ],
      );
    });

    await t.test('q10: la droguería no tiene clientes; inexistente y sin parámetro', async () => {
      assert.deepEqual((await q10(ctx, { id_sucursal: 'S005' })).clientes, []);
      await assert.rejects(q10(ctx, { id_sucursal: 'S999' }), { code: 'SUCURSAL_INVALIDA' });
      await assert.rejects(q10(ctx, {}), { code: 'PARAMETROS_INVALIDOS' });
    });

    await t.test('q10: un cambio de sucursal del farmacéutico no mueve su historia', async () => {
      const { _id, ...f003 } = await db
        .collection('farmaceuticos')
        .findOne({ id_farmaceutico: 'F003' });
      await aplicarEvento(driver, database, {
        id_evento: 'farmaceutico:F003:2',
        tipo_entidad: 'farmaceutico',
        id_entidad: 'F003',
        version: 2,
        contenido: { ...f003, id_sucursal: 'S001', version: 2 },
      });
      const { clientes } = await q10(ctx, { id_sucursal: 'S002' });
      assert.deepEqual(
        clientes.map((c) => c.id_cliente),
        ['C001', 'C004'],
      );
    });

    await t.test('q12: sin ventas en el último año, incluido quien nunca compró', async () => {
      const { clientes } = await q12(ctx);
      assert.deepEqual(
        clientes.map((c) => [c.id_cliente, c.activo, c.nunca_compro]),
        [
          ['C004', true, false],
          ['C008', false, true],
        ],
      );
      assert.ok(clientes[0].ultima_compra instanceof Date);
      assert.equal(clientes[1].ultima_compra, null);
    });
  } finally {
    await vaciarGrafo(driver, database);
    await db.dropDatabase();
    await client.close();
    await driver.close();
  }
});
