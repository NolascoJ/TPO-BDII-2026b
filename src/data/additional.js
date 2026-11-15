const id = (tipo, numero) => `AD-${tipo}${String(numero).padStart(3, '0')}`;
const personas = [
  'Ana',
  'Bruno',
  'Carla',
  'Diego',
  'Elena',
  'Fabio',
  'Gabriela',
  'Hugo',
  'Inés',
  'Julián',
  'Laura',
  'Marcos',
  'Nadia',
  'Oscar',
  'Paula',
  'Ramiro',
  'Sofía',
  'Tomás',
  'Valeria',
  'Walter',
];
const lugares = [
  ['La Plata', 'Buenos Aires'],
  ['Rosario', 'Santa Fe'],
  ['Córdoba', 'Córdoba'],
];
const veinte = (crear) => Array.from({ length: 20 }, (_, i) => crear(i + 1));

export function generarAdicionales(fechaBase) {
  const base = new Date(`${fechaBase}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(fechaBase) ||
    !Number.isFinite(base.getTime()) ||
    base.toISOString().slice(0, 10) !== fechaBase
  ) {
    throw new Error('La fecha base debe ser una fecha válida AAAA-MM-DD');
  }
  const dia = (dias) => new Date(base.getTime() + dias * 86400000);
  const mesAnterior = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 0));
  const ubicacion = (n) => ({
    ciudad: lugares[(n - 1) % 3][0],
    provincia: lugares[(n - 1) % 3][1],
  });
  const coberturas = ['OSDE', 'Swiss Medical', 'PAMI', 'IOMA', 'Galeno', 'Sin cobertura'];
  const clientes = veinte((n) => ({
    id_cliente: id('C', n),
    nombre: personas[n - 1],
    apellido: `Ejemplo ${n}`,
    dni: String(80000000 + n),
    email: `cliente${n}@example.test`,
    telefono: `0115555${String(n).padStart(4, '0')}`,
    ...ubicacion(n),
    obra_social: coberturas[(n - 1) % 6],
    nro_afiliado: n % 6 === 0 ? null : `AF-${n}`,
    activo: n <= 16,
  }));
  const sucursales = veinte((n) => ({
    id_sucursal: id('S', n),
    nombre: `Sucursal adicional ${n}`,
    tipo: n <= 18 ? 'Farmacia' : 'Droguería',
    direccion: `Calle Ejemplo ${100 + n}`,
    ...ubicacion(n),
    telefono: null,
    activo: ![17, 18].includes(n),
  }));
  const farmaceuticos = veinte((n) => ({
    id_farmaceutico: id('F', n),
    nombre: personas[n - 1],
    apellido: `Profesional ${n}`,
    matricula: `AD-MAT-${n}`,
    cargo: n % 2 ? 'Director Técnico' : 'Farmacéutico',
    id_sucursal: id('S', n <= 18 ? n : n - 18),
    activo: n <= 16,
  }));
  const proveedores = veinte((n) => ({
    id_proveedor: id('PV', n),
    razon_social: `Proveedor adicional ${n}`,
    cuit: `30-${String(80000000 + n)}-${n % 10}`,
    tipo: n <= 12 ? 'Laboratorio' : 'Droguería',
    ...ubicacion(n),
    telefono: null,
    activo: n <= 18,
  }));
  const condiciones = [
    ...Array(8).fill('Venta libre'),
    ...Array(8).fill('Bajo receta'),
    ...Array(4).fill('Bajo receta archivada'),
  ];
  const productos = veinte((n) => ({
    id_producto: id('P', n),
    nombre: `Producto adicional ${n}`,
    principio_activo: `Compuesto de ejemplo ${n}`,
    categoria: n <= 8 ? 'Cuidado personal' : 'Medicamento',
    presentacion: 'Caja de 10 unidades',
    condicion_venta: condiciones[n - 1],
    precio_unit: [4999, 5000, 5001][n - 1] ?? 1000,
    id_proveedor: id('PV', n === 1 ? 19 : n),
    activo: ![8, 16, 19, 20].includes(n),
  }));
  // Producto, sucursal, saldo disponible y vencimiento relativo a la fecha base.
  const lotes = [
    [9, 1, 4, -1],
    [9, 1, 3, 0],
    [9, 1, 10, 30],
    [1, 1, 20, -10],
    [1, 1, 5, 1],
    [1, 1, 15, 60],
    [2, 2, 0, 60],
    [3, 3, 1, 60],
    [4, 4, 49, 60],
    [5, 5, 50, 60],
    [9, 2, 100, 10],
    [9, 3, 100, 10],
    [1, 2, 100, 30],
    [1, 3, 100, 30],
    [10, 2, 40, 60],
    [11, 3, 40, 60],
    [17, 4, 40, 60],
    [6, 6, 40, 60],
    [9, 19, 1000, 90],
    [1, 20, 2000, 90],
  ];
  const stock_lotes = lotes.map(([producto, sucursal, unidades, dias], i) => ({
    id_lote: id('L', i + 1),
    id_producto: id('P', producto),
    id_sucursal: id('S', sucursal),
    nro_lote: `AD-LOTE-${i + 1}`,
    unidades,
    vencimiento: dia(dias),
  }));
  const clientesReceta = [4, 5, 6, 13, 1, 2, 3, 8, 9, 10, 4, 9, 10, 6, 7, 11, 7, 13, 14, 15];
  const tiposReceta = [
    ...Array(10).fill('Tratamiento prolongado'),
    ...Array(6).fill('Simple'),
    ...Array(4).fill('Archivada'),
  ];
  const recetas = veinte((n) => {
    const realizadas = { 1: 3, 2: 1, 3: 1, 12: 1, 13: 1, 17: 1 };
    const proximas = { 2: 30, 3: 30, 4: -1, 5: -5, 6: -10, 7: -20, 8: 0, 9: 0 };
    let estado = 'Vigente';
    if ([1, 12, 13, 17].includes(n)) {
      estado = 'Completada';
    }
    if ([10, 15, 20].includes(n)) {
      estado = 'Vencida';
    }
    return {
      id_receta: id('R', n),
      id_cliente: id('C', clientesReceta[n - 1]),
      medico: `Médico de ejemplo ${n}`,
      matricula_medico: `AD-MED-${n}`,
      fecha_emision: dia({ 1: -90, 12: -95, 13: -405 }[n] ?? -60),
      tipo: tiposReceta[n - 1],
      dispensas_autorizadas: n <= 10 ? 3 : 1,
      dispensas_realizadas: realizadas[n] ?? 0,
      proxima_dispensa: Object.hasOwn(proximas, n) ? dia(proximas[n]) : null,
      estado,
    };
  });
  // Cliente, profesional, producto, cantidad, receta y fecha. Son ventas históricas importadas.
  const operaciones = [
    [1, 1, 1, 1, null, dia(0)],
    [2, 2, 2, 1, null, dia(0)],
    [3, 3, 3, 1, null, dia(0)],
    [4, 1, 9, 2, 1, dia(0)],
    [5, 2, 10, 3, 2, dia(0)],
    [6, 3, 11, 4, 3, dia(0)],
    [7, 19, 17, 1, 17, dia(0)],
    [4, 1, 9, 5, 1, dia(0)],
    [4, 1, 9, 6, 1, dia(-59)],
    [8, 5, 4, 20, null, mesAnterior],
    [17, 7, 8, 7, null, dia(-61)],
    [9, 17, 13, 8, 12, dia(-90)],
    [10, 1, 14, 9, 13, dia(-400)],
    [18, 2, 7, 10, null, dia(-410)],
    [11, 1, 1, 1, null, dia(0)],
    [12, 2, 4, 100, null, dia(0)],
    [13, 3, 12, 2, 4, dia(0)],
    [11, 4, 5, 4, null, dia(-70)],
    [15, 5, 1, 1, null, dia(0)],
    [16, 6, 4, 200, null, dia(0)],
  ];
  const estados = [
    ...Array(14).fill('Completada'),
    ...Array(4).fill('Pendiente'),
    ...Array(2).fill('Anulada'),
  ];
  const ventas = operaciones.map(
    ([cliente, profesional, producto, cantidad, receta, fecha], i) => ({
      id_venta: id('V', i + 1),
      id_cliente: id('C', cliente),
      id_farmaceutico: id('F', profesional),
      id_receta: receta === null ? null : id('R', receta),
      fecha,
      tipo: receta === null ? 'Venta libre' : 'Con receta',
      medio_pago: 'Efectivo',
      total: productos[producto - 1].precio_unit * cantidad,
      estado: estados[i],
    }),
  );
  const detalle_ventas = operaciones.map(([, , producto, cantidad], i) => ({
    id_detalle: id('D', i + 1),
    id_venta: id('V', i + 1),
    id_producto: id('P', producto),
    cantidad,
    precio_unit: productos[producto - 1].precio_unit,
  }));
  return {
    clientes,
    sucursales,
    farmaceuticos,
    proveedores,
    productos,
    stock_lotes,
    recetas,
    ventas,
    detalle_ventas,
  };
}

export function aCSV(filas) {
  const campos = Object.keys(filas[0]);
  const celda = (valor) => {
    let texto = String(valor);
    if (valor === null) {
      texto = '';
    }
    if (valor instanceof Date) {
      texto = valor.toISOString().slice(0, 10);
    }
    if (typeof valor === 'boolean') {
      texto = valor ? 'True' : 'False';
    }
    return /[",\n\r]/.test(texto) ? `"${texto.replaceAll('"', '""')}"` : texto;
  };
  return (
    [
      campos.join(','),
      ...filas.map((fila) => campos.map((campo) => celda(fila[campo])).join(',')),
    ].join('\n') + '\n'
  );
}
