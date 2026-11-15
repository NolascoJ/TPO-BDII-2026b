import test from 'node:test';
import assert from 'node:assert/strict';
import { connectNeo4j } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureGraphSchema } from '../../src/graph/schema.js';

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
