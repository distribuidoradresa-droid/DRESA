import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../src/database.js';
import { getInventory } from '../src/domain.js';
import { createApp } from '../src/server.js';

let db;
let server;
let base;
let admin;
const bootstrapToken = 'integration-test-bootstrap-token';

beforeEach(async () => {
  db = createDatabase(':memory:');
  server = createApp(db, { bootstrapToken });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const deviceId = randomUUID();
  const response = await fetch(`${base}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DRESA-Device': deviceId },
    body: JSON.stringify({
      bootstrapToken, name: 'Administrador de prueba', username: 'admin', password: 'Secure-test-password-2026',
      deviceId, deviceName: 'Matriz de prueba',
    }),
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  admin = {
    cookie: response.headers.get('set-cookie').split(';')[0],
    deviceId,
    csrfToken: session.csrfToken,
    userId: session.user.id,
  };
  const warehouse = await request('/api/admin/warehouses', {
    code: 'TEST-MAIN', name: 'Bodega de pruebas',
  });
  assert.equal(warehouse.status, 201);
  const route = await request('/api/admin/routes/route-001', {
    name: 'Ruta 001', warehouseId: warehouse.body.id, active: true,
  }, 'PUT');
  assert.equal(route.status, 200);
});

afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});

async function request(path, body, method = 'POST', session = admin) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) {
    headers.Cookie = session.cookie;
    headers['X-DRESA-Device'] = session.deviceId;
    if (session.csrfToken) headers['X-DRESA-CSRF'] = session.csrfToken;
  } else if (body?.deviceId) {
    headers['X-DRESA-Device'] = body.deviceId;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), setCookie: response.headers.get('set-cookie') };
}

async function createAccount(username, role = 'VENDEDOR') {
  const result = await request('/api/admin/users', {
    name: `Usuario ${username}`, username, role,
    ...(role === 'ADMIN' ? {} : { routeId: 'route-001' }),
    password: 'Safe-password-for-test-2026',
  });
  assert.equal(result.status, 201);
  return result.body;
}

async function enrollDevice(user, deviceId = randomUUID()) {
  const credentials = {
    username: user.username, password: 'Safe-password-for-test-2026',
    deviceId, deviceName: `Dispositivo ${user.username}`,
  };
  const pending = await request('/api/auth/login', credentials, 'POST', null);
  assert.equal(pending.status, 403);
  assert.equal(pending.body.code, 'DEVICE_PENDING');
  const approval = await request(`/api/admin/users/${user.id}/devices/${deviceId}/approve`, { revokePrevious: true });
  assert.equal(approval.status, 200);
  const login = await request('/api/auth/login', credentials, 'POST', null);
  assert.equal(login.status, 200);
  return { cookie: login.setCookie.split(';')[0], deviceId, csrfToken: login.body.csrfToken };
}

async function fixture() {
  const product = await request('/api/products', {
    code: 'D-001', name: 'Producto de prueba', category: 'Bebidas', unit: 'unidad',
    price: 15, stock: 10, operatingDate: new Date().toLocaleDateString('en-CA'),
  });
  assert.equal(product.status, 201);
  const client = await request('/api/sync', { operations: [{
    id: 'client-001', kind: 'client',
    payload: { name: 'Tienda central', routeId: 'route-001' },
  }] });
  assert.equal(client.body.results[0].ok, true);
  return { productId: product.body.id, clientId: 'client-001', date: new Date().toLocaleDateString('en-CA') };
}

test('migra productos heredados sin cambiar nombre, código, categoría o precio', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dresa-products-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE products (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', weight TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT 'unidad', price REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO products (id, code, name, category, price, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('legacy-1', 'D-OLD', 'Nombre anterior', 'Categoría anterior', 17.25, 0, '2025-01-02T00:00:00.000Z');
  legacy.close();
  let migrated;
  try {
    migrated = createDatabase(path);
    const product = migrated.prepare('SELECT * FROM products WHERE id = ?').get('legacy-1');
    assert.equal(product.code, 'D-OLD');
    assert.equal(product.name, 'Nombre anterior');
    assert.equal(product.short_name, 'Nombre anterior');
    assert.equal(product.description, '');
    assert.equal(product.category, 'Categoría anterior');
    assert.equal(product.price, 17.25);
    assert.equal(product.active, 0);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM product_price_history WHERE product_id = ?').get('legacy-1').count, 1);
  } finally {
    migrated?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('productos validan campos, buscan atributos, conservan precio y cambian estado sin borrar historial', async () => {
  const productData = {
    code: 'CAT-001', shortName: 'Galleta corta', description: 'Galleta de prueba 250 g',
    brand: 'Marca de prueba', category: 'Categoría previa', family: 'Familia de prueba',
    weight: '250 g', unit: 'caja', price: 20.5, stock: 4,
  };
  const created = await request('/api/products', productData);
  assert.equal(created.status, 201);
  const productId = created.body.id;
  const found = await request('/api/products?q=Familia%20de%20prueba', undefined, 'GET');
  assert.equal(found.body.length, 1);
  assert.equal(found.body[0].short_name, productData.shortName);
  assert.equal(found.body[0].description, productData.description);
  assert.equal(found.body[0].family, productData.family);
  assert.equal(found.body[0].price, productData.price);
  assert.equal(found.body[0].stock, 4);
  const second = await request('/api/products', {
    ...productData, code: 'CAT-002', shortName: 'Otro producto',
  });
  assert.equal(second.status, 201);

  const missingDescription = await request('/api/products', {
    code: 'CAT-BAD', shortName: 'Incompleto', unit: 'unidad', price: 1,
  });
  const missingShortName = await request('/api/products', {
    code: 'CAT-BAD-2', description: 'Incompleto', unit: 'unidad', price: 1,
  });
  const missingUnit = await request('/api/products', {
    code: 'CAT-BAD-3', shortName: 'Incompleto', description: 'Incompleto', unit: '', price: 1,
  });
  const missingPrice = await request('/api/products', {
    code: 'CAT-BAD-4', shortName: 'Incompleto', description: 'Incompleto', unit: 'unidad',
  });
  assert.deepEqual([missingDescription.status, missingShortName.status, missingUnit.status, missingPrice.status], [422, 422, 422, 422]);

  const duplicate = await request('/api/products', { ...productData, code: 'cat-001' });
  assert.equal(duplicate.status, 409);
  const duplicateEdit = await request(`/api/products/${productId}`, { code: 'CAT-002' }, 'PUT');
  assert.equal(duplicateEdit.status, 409);
  const changed = await request(`/api/products/${productId}`, {
    code: productData.code, shortName: 'Galleta actualizada', description: 'Descripción actualizada',
    brand: 'Marca de prueba', category: 'Categoría previa', family: 'Familia actualizada',
    weight: '300 g', unit: 'caja', price: 20.5, active: 1,
  }, 'PUT');
  assert.equal(changed.status, 200);
  const changedProduct = (await request('/api/products', undefined, 'GET')).body[0];
  assert.equal(changedProduct.name, 'Galleta actualizada');
  assert.equal(changedProduct.description, 'Descripción actualizada');
  assert.equal(changedProduct.family, 'Familia actualizada');
  assert.equal(changedProduct.price, 20.5);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_price_history WHERE product_id = ?').get(productId).count, 1);

  const deactivated = await request(`/api/products/${productId}`, { active: false }, 'PATCH');
  assert.deepEqual(deactivated.body, { id: productId, active: false });
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].active, 0);
  assert.equal((await request('/api/products?q=actualizada', undefined, 'GET')).body.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?').get(productId).count, 1);
  const activated = await request(`/api/products/${productId}`, { active: true }, 'PATCH');
  assert.equal(activated.body.active, true);
  const invalid = await request(`/api/products/${productId}`, { active: 'yes' }, 'PATCH');
  assert.equal(invalid.status, 422);
});

test('solo ADMIN administra productos y los inactivos quedan excluidos de venta/preventa', async () => {
  const { productId, clientId, date } = await fixture();
  const sellerUser = await createAccount('product-seller', 'VENDEDOR');
  const seller = await enrollDevice(sellerUser);
  const blockedCreate = await request('/api/products', {
    code: 'SELLER-PRODUCT', name: 'No permitido', unit: 'unidad', price: 5,
  }, 'POST', seller);
  const blockedEdit = await request(`/api/products/${productId}`, { price: 1 }, 'PUT', seller);
  const blockedStatus = await request(`/api/products/${productId}`, { active: false }, 'PATCH', seller);
  assert.deepEqual([blockedCreate.status, blockedEdit.status, blockedStatus.status], [403, 403, 403]);
  assert.equal((await request('/api/products?q=D-001', undefined, 'GET', seller)).body.length, 1);

  assert.equal((await request(`/api/products/${productId}`, { active: false }, 'PATCH')).status, 200);
  assert.equal((await request('/api/products', undefined, 'GET', seller)).body.length, 0);
  const sale = await request('/api/sync', { operations: [{
    id: 'inactive-product-sale', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 1 }] },
  }] }, 'POST', seller);
  assert.equal(sale.body.results[0].ok, false);
  assert.match(sale.body.results[0].error, /inactivo/);
  assert.equal((await request('/api/sales', undefined, 'GET')).body.length, 0);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
});

test('entradas, salidas, ajustes y devoluciones actualizan stock con historial idempotente', async () => {
  const { productId, date } = await fixture();
  const postMovement = (id, kind, quantity, reference) => request('/api/sync', { operations: [{
    id, kind: 'movement',
    payload: { productId, kind, quantity, operatingDate: date, reference },
  }] });

  const entry = await postMovement('inventory-entry-001', 'ENTRY', 5, 'Recepción DOC-001');
  const duplicateEntry = await postMovement('inventory-entry-001', 'ENTRY', 5, 'Recepción DOC-001');
  const reusedId = await postMovement('inventory-entry-001', 'ENTRY', 7, 'Referencia distinta');
  assert.equal(entry.body.results[0].ok, true);
  assert.equal(duplicateEntry.body.results[0].result.duplicate, true);
  assert.equal(reusedId.body.results[0].ok, false);
  assert.match(reusedId.body.results[0].error, /identificador.*otra operación/);

  assert.equal((await postMovement('inventory-exit-001', 'EXIT', 4, 'Salida DOC-002')).body.results[0].ok, true);
  assert.equal((await postMovement('inventory-adjustment-001', 'ADJUSTMENT', -2, 'Conteo físico')).body.results[0].ok, true);
  assert.equal((await postMovement('inventory-return-001', 'RETURN', 1, 'Devolución DOC-003')).body.results[0].ok, true);
  const insufficient = await postMovement('inventory-exit-insufficient', 'EXIT', 11, 'Salida excedida');
  assert.equal(insufficient.body.results[0].ok, false);
  assert.match(insufficient.body.results[0].error, /Inventario insuficiente/);

  const product = (await request('/api/products', undefined, 'GET')).body.find((row) => row.id === productId);
  const inventory = (await request('/api/inventory', undefined, 'GET')).body.find((row) => row.id === productId);
  assert.equal(product.stock, 10);
  assert.equal(inventory.stock, product.stock);
  assert.equal(inventory.entries, 15);
  assert.equal(inventory.exits, 4);
  assert.equal(inventory.adjustments, -2);
  assert.equal(inventory.returns, 1);
  assert.throws(() => db.prepare(`INSERT INTO inventory_movements
    (id, product_id, kind, quantity_delta, operating_date, created_at)
    VALUES (?, ?, 'EXIT', -11, ?, ?)`).run('direct-negative-inventory', productId, date, new Date().toISOString()),
  /Inventario insuficiente/);
  assert.equal((await request('/api/products', undefined, 'GET')).body.find((row) => row.id === productId).stock, 10);
  const movements = (await request('/api/movements', undefined, 'GET')).body
    .filter((movement) => ['inventory-entry-001', 'inventory-exit-001', 'inventory-adjustment-001', 'inventory-return-001']
      .includes(movement.id));
  assert.equal(movements.length, 4);
  for (const movement of movements) {
    assert.equal(movement.actor_name, 'Administrador de prueba');
    assert.equal(movement.created_by, admin.userId);
    assert.equal(movement.operating_date, date);
    assert.ok(Number.isFinite(Date.parse(movement.created_at)));
    assert.ok(movement.note);
  }
  assert.equal(movements.find((movement) => movement.id === 'inventory-entry-001').note, 'Recepción DOC-001');
});

test('solo ADMIN registra movimientos; vendedores y preventa no alteran inventario', async () => {
  const { productId, date } = await fixture();
  for (const role of ['VENDEDOR', 'PREVENTA']) {
    const user = await createAccount(`inventory-${role.toLowerCase()}`, role);
    const session = await enrollDevice(user);
    const result = await request('/api/sync', { operations: [{
      id: `blocked-inventory-${role}`, kind: 'movement',
      payload: { productId, kind: 'ENTRY', quantity: 4, operatingDate: date, reference: 'No autorizado' },
    }] }, 'POST', session);
    assert.equal(result.status, 403);
    assert.equal((await request('/api/inventory', undefined, 'GET', session)).status, 403);
    assert.equal((await request('/api/movements', undefined, 'GET', session)).status, 403);
  }
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.length, 1);
});

test('un producto inactivo conserva stock e historial y rechaza movimientos nuevos', async () => {
  const { productId } = await fixture();
  assert.equal((await request(`/api/products/${productId}`, { active: false }, 'PATCH')).status, 200);
  const result = await request('/api/sync', { operations: [{
    id: 'inactive-product-inventory-entry', kind: 'movement',
    payload: { productId, kind: 'ENTRY', quantity: 3, operatingDate: new Date().toLocaleDateString('en-CA') },
  }] });
  assert.equal(result.body.results[0].ok, false);
  assert.match(result.body.results[0].error, /inactivo/);
  const product = (await request('/api/products', undefined, 'GET')).body[0];
  assert.equal(product.active, 0);
  assert.equal(product.stock, 10);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.length, 1);
});

test('migración de inventario heredado conserva movimientos y añade la trazabilidad disponible', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dresa-inventory-'));
  const path = join(directory, 'legacy-inventory.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE products (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', weight TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT 'unidad', price REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  INSERT INTO products (id, code, name, price, created_at)
    VALUES ('legacy-product', 'OLD-001', 'Producto heredado', 5, '2025-01-01T00:00:00.000Z');
  CREATE TABLE inventory_movements (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
    kind TEXT NOT NULL, quantity_delta REAL NOT NULL, note TEXT NOT NULL DEFAULT '',
    sale_id TEXT, operating_date TEXT NOT NULL, created_at TEXT NOT NULL
  );
  INSERT INTO inventory_movements
    (id, product_id, kind, quantity_delta, note, operating_date, created_at)
    VALUES ('legacy-movement', 'legacy-product', 'OPENING', 6, 'Saldo inicial heredado',
      '2025-01-01', '2025-01-01T00:00:00.000Z');`);
  legacy.close();
  let migrated;
  try {
    migrated = createDatabase(path);
    const movementColumns = migrated.prepare('PRAGMA table_info(inventory_movements)').all();
    assert.ok(movementColumns.some((column) => column.name === 'created_by'));
    assert.equal(migrated.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name = 'inventory_movements_prevent_negative_stock'`).get().count, 1);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count, 1);
    assert.equal(migrated.prepare('SELECT note FROM inventory_movements WHERE id = ?').get('legacy-movement').note, 'Saldo inicial heredado');
    assert.equal(getInventory(migrated)[0].stock, 6);
  } finally {
    migrated?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('autoventa valida cliente, precio, cantidad y venta repetida sin duplicar stock ni historial', async () => {
  const { productId, clientId, date } = await fixture();
  const user = await createAccount('sales-idempotency');
  const seller = await enrollDevice(user);
  const operation = {
    id: 'sales-idempotency-001', kind: 'sale',
    payload: {
      clientId, kind: 'AUTOVENTA', operatingDate: date, occurredAt: `${date}T15:30:00.000Z`,
      reference: 'Pedido / referencia VT-77',
      lines: [{ productId, quantity: 2.5, unitPrice: 15 }],
    },
  };
  const first = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  const retry = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  assert.equal(first.body.results[0].ok, true);
  assert.equal(retry.body.results[0].result.duplicate, true);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 7.5);
  const sale = (await request('/api/sales', undefined, 'GET')).body.find((row) => row.id === operation.id);
  assert.equal(sale.total, 37.5);
  assert.equal(sale.reference, operation.payload.reference);
  assert.equal(sale.created_by, user.id);
  assert.equal(sale.seller_name, user.name);
  assert.equal(sale.operating_date, date);
  assert.equal(sale.occurred_at, operation.payload.occurredAt);
  assert.ok(Number.isFinite(Date.parse(sale.created_at)));
  assert.deepEqual(JSON.parse(sale.lines).map((line) => [line.quantity, line.unitPrice]), [[2.5, 15]]);
  const movements = (await request('/api/movements', undefined, 'GET')).body.filter((row) => row.sale_id === operation.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].quantity_delta, -2.5);
  assert.equal(movements[0].created_by, user.id);

  const reusedId = structuredClone(operation);
  reusedId.payload.lines[0].quantity = 1;
  const collision = await request('/api/sync', { operations: [reusedId] }, 'POST', seller);
  assert.equal(collision.body.results[0].ok, false);
  assert.match(collision.body.results[0].error, /identificador de venta.*otra operación/);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 7.5);
  assert.equal((await request('/api/sales', undefined, 'GET')).body.length, 1);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.filter((row) => row.sale_id === operation.id).length, 1);

  const invalidClient = structuredClone(operation);
  invalidClient.id = 'sales-invalid-client';
  invalidClient.payload.clientId = 'missing-client';
  const invalidQuantity = structuredClone(operation);
  invalidQuantity.id = 'sales-invalid-quantity';
  invalidQuantity.payload.lines[0].quantity = true;
  const wrongPrice = structuredClone(operation);
  wrongPrice.id = 'sales-wrong-price';
  wrongPrice.payload.lines[0].unitPrice = 100;
  for (const invalid of [invalidClient, invalidQuantity, wrongPrice]) {
    const response = await request('/api/sync', { operations: [invalid] }, 'POST', seller);
    assert.equal(response.body.results[0].ok, false);
  }
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 7.5);
  assert.equal((await request('/api/sales', undefined, 'GET')).body.length, 1);
});

test('preventa registra referencia y total, conserva stock y despacho lo descuenta solo una vez', async () => {
  const { productId, clientId, date } = await fixture();
  const user = await createAccount('preorder-audit', 'PREVENTA');
  const seller = await enrollDevice(user);
  const operation = {
    id: 'preorder-audit-001', kind: 'sale',
    payload: {
      clientId, kind: 'PREVENTA', operatingDate: date, occurredAt: `${date}T16:15:00.000Z`,
      reference: 'Entregar en horario de tarde',
      lines: [{ productId, quantity: 3, unitPrice: 15 }],
    },
  };
  const first = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  const retry = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  assert.equal(first.body.results[0].result.status, 'PENDING');
  assert.equal(retry.body.results[0].result.duplicate, true);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
  let sale = (await request('/api/sales', undefined, 'GET')).body.find((row) => row.id === operation.id);
  assert.equal(sale.total, 45);
  assert.equal(sale.reference, operation.payload.reference);
  assert.equal(sale.created_by, user.id);
  assert.equal(sale.status, 'PENDING');
  const dispatch = await request('/api/dispatch', { id: operation.id, operatingDate: date });
  const duplicateDispatch = await request('/api/dispatch', { id: operation.id, operatingDate: date });
  assert.equal(dispatch.body.status, 'DISPATCHED');
  assert.equal(duplicateDispatch.body.duplicate, true);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 7);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.filter((row) => row.sale_id === operation.id).length, 1);
  sale = (await request('/api/sales', undefined, 'GET')).body.find((row) => row.id === operation.id);
  assert.equal(sale.reference, operation.payload.reference);
  assert.equal(sale.dispatched_by, admin.userId);
});

test('preventa con stock insuficiente queda pendiente y no modifica el inventario al fallar despacho', async () => {
  const { productId, clientId, date } = await fixture();
  const preorder = await request('/api/sync', { operations: [{
    id: 'preorder-insufficient-stock', kind: 'sale',
    payload: {
      clientId, kind: 'PREVENTA', operatingDate: date,
      lines: [{ productId, quantity: 11, unitPrice: 15 }],
    },
  }] });
  assert.equal(preorder.body.results[0].ok, true);
  assert.equal(preorder.body.results[0].result.status, 'PENDING');
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
  const dispatch = await request('/api/dispatch', { id: 'preorder-insufficient-stock', operatingDate: date });
  assert.equal(dispatch.status, 422);
  assert.match(dispatch.body.error, /Inventario insuficiente/);
  const [sale] = (await request('/api/sales', undefined, 'GET')).body;
  assert.equal(sale.status, 'PENDING');
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.filter((row) => row.sale_id).length, 0);
});

test('la matriz modifica una preventa pendiente y el despacho usa los cambios exactamente una vez', async () => {
  const { productId, clientId, date } = await fixture();
  const preorderId = 'preorder-editable-001';
  const created = await request('/api/sync', { operations: [{
    id: preorderId, kind: 'sale',
    payload: { clientId, kind: 'PREVENTA', operatingDate: date, reference: 'Original',
      lines: [{ productId, quantity: 2, unitPrice: 15 }] },
  }] });
  assert.equal(created.body.results[0].ok, true);

  const sellerUser = await createAccount('preorder-edit-denied', 'PREVENTA');
  const seller = await enrollDevice(sellerUser);
  const sellerEdit = await request(`/api/preorders/${preorderId}`, {
    clientId, operatingDate: date, reference: 'No autorizado', lines: [{ productId, quantity: 1 }],
  }, 'PUT', seller);
  assert.equal(sellerEdit.status, 403);

  const edited = await request(`/api/preorders/${preorderId}`, {
    clientId, operatingDate: date, reference: 'Pedido actualizado',
    lines: [{ productId, quantity: 4 }],
  }, 'PUT');
  assert.equal(edited.status, 200);
  assert.equal(edited.body.updated, true);
  assert.equal((await request('/api/products', undefined, 'GET')).body.find((row) => row.id === productId).stock, 10);
  const pending = (await request('/api/sales', undefined, 'GET')).body.find((row) => row.id === preorderId);
  assert.equal(pending.reference, 'Pedido actualizado');
  assert.equal(pending.total, 60);
  assert.equal(JSON.parse(pending.lines)[0].quantity, 4);

  const dispatch = await request('/api/dispatch', { id: preorderId, operatingDate: date });
  const retry = await request('/api/dispatch', { id: preorderId, operatingDate: date });
  assert.equal(dispatch.body.status, 'DISPATCHED');
  assert.equal(retry.body.duplicate, true);
  assert.equal((await request('/api/products', undefined, 'GET')).body.find((row) => row.id === productId).stock, 6);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.filter((row) => row.sale_id === preorderId).length, 1);
  assert.equal((await request(`/api/preorders/${preorderId}`, {
    clientId, operatingDate: date, reference: 'Cambio posterior',
    lines: [{ productId, quantity: 1 }],
  }, 'PUT')).status, 422);
});

test('migración aditiva de ventas conserva registros y agrega referencia vacía a los anteriores', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dresa-sales-'));
  const path = join(directory, 'legacy-sales.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE products (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', short_name TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '', family TEXT NOT NULL DEFAULT '', weight TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT 'unidad', price REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE clients (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, tax_id TEXT NOT NULL DEFAULT '', full_name TEXT NOT NULL DEFAULT '',
    business_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    latitude REAL, longitude REAL, route_id TEXT NOT NULL DEFAULT 'route-001', active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT, updated_by TEXT, updated_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE sales (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id),
    kind TEXT NOT NULL, status TEXT NOT NULL, operating_date TEXT NOT NULL, occurred_at TEXT NOT NULL,
    created_by TEXT, dispatched_by TEXT, dispatched_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE sale_lines (
    sale_id TEXT NOT NULL REFERENCES sales(id), product_id TEXT NOT NULL REFERENCES products(id),
    quantity REAL NOT NULL, unit_price REAL NOT NULL, PRIMARY KEY (sale_id, product_id)
  );
  INSERT INTO products (id, code, name, price, created_at)
    VALUES ('legacy-sale-product', 'S-OLD', 'Producto histórico', 9, '2025-03-04T10:00:00.000Z');
  INSERT INTO clients (id, name, created_at) VALUES ('legacy-sale-client', 'Cliente histórico', '2025-03-04T10:00:00.000Z');
  INSERT INTO sales (id, client_id, kind, status, operating_date, occurred_at, created_at)
    VALUES ('legacy-sale', 'legacy-sale-client', 'AUTOVENTA', 'COMPLETED', '2025-03-04',
      '2025-03-04T10:00:00.000Z', '2025-03-04T10:00:00.000Z');
  INSERT INTO sale_lines (sale_id, product_id, quantity, unit_price)
    VALUES ('legacy-sale', 'legacy-sale-product', 2, 9);`);
  legacy.close();
  let migrated;
  try {
    migrated = createDatabase(path);
    const sale = migrated.prepare('SELECT * FROM sales WHERE id = ?').get('legacy-sale');
    assert.equal(sale.reference, '');
    assert.equal(sale.client_id, 'legacy-sale-client');
    assert.equal(migrated.prepare('SELECT quantity, unit_price FROM sale_lines WHERE sale_id = ?').get('legacy-sale').quantity, 2);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM sales').get().count, 1);
  } finally {
    migrated?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('autoventa descuenta stock una sola vez aunque el lote se reenvíe', async () => {
  const { productId, clientId, date } = await fixture();
  const operation = {
    id: 'sale-auto-001', kind: 'sale',
    payload: {
      clientId, kind: 'AUTOVENTA', operatingDate: date, occurredAt: `${date}T15:30:00.000Z`,
      lines: [{ productId, quantity: 2, unitPrice: 15 }],
    },
  };
  const first = await request('/api/sync', { operations: [operation] });
  const retry = await request('/api/sync', { operations: [operation] });
  assert.equal(first.body.results[0].ok, true);
  assert.equal(retry.body.results[0].result.duplicate, true);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 8);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.filter((row) => row.kind === 'SALE').length, 1);
  const [sale] = (await request('/api/sales', undefined, 'GET')).body;
  assert.equal(sale.occurred_at, `${date}T15:30:00.000Z`);
  assert.equal(sale.total, 30);
});

test('preventa no consume stock hasta despacho y despacho es idempotente', async () => {
  const { productId, clientId, date } = await fixture();
  const preorder = await request('/api/sync', { operations: [{
    id: 'sale-pre-001', kind: 'sale',
    payload: { clientId, kind: 'PREVENTA', operatingDate: date, lines: [{ productId, quantity: 3 }] },
  }] });
  assert.equal(preorder.body.results[0].result.status, 'PENDING');
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
  const dispatch = await request('/api/dispatch', { id: 'sale-pre-001', operatingDate: date });
  const retry = await request('/api/dispatch', { id: 'sale-pre-001', operatingDate: date });
  assert.equal(dispatch.body.status, 'DISPATCHED');
  assert.equal(retry.body.duplicate, true);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 7);
  const [dispatchedSale] = (await request('/api/sales', undefined, 'GET')).body;
  assert.equal(dispatchedSale.dispatched_by, admin.userId);
  assert.ok(dispatchedSale.dispatched_at);
  const dispatchMovement = (await request('/api/movements', undefined, 'GET')).body.find((row) => row.sale_id === 'sale-pre-001');
  assert.equal(dispatchMovement.actor_name, 'Administrador de prueba');
});

test('venta sin stock se rechaza sin registrar venta ni movimiento', async () => {
  const { productId, clientId, date } = await fixture();
  const result = await request('/api/sync', { operations: [{
    id: 'sale-too-large', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 11 }] },
  }] });
  assert.equal(result.body.results[0].ok, false);
  assert.match(result.body.results[0].error, /Inventario insuficiente/);
  assert.equal((await request('/api/sales', undefined, 'GET')).body.length, 0);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
});

test('ajuste, ventas, entradas y cierre cuadran y bloquean operaciones del día cerrado', async () => {
  const { productId, clientId, date } = await fixture();
  await request('/api/sync', { operations: [{
    id: 'sale-close-001', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 2 }] },
  }] });
  await request('/api/sync', { operations: [{
    id: 'movement-entry-001', kind: 'movement',
    payload: { productId, kind: 'ENTRY', quantity: 4, operatingDate: date },
  }] });
  await request('/api/sync', { operations: [{
    id: 'movement-adjustment-001', kind: 'movement',
    payload: { productId, kind: 'ADJUSTMENT', quantity: -1, operatingDate: date },
  }] });
  const closing = await request('/api/closings', { closingDate: date });
  const duplicate = await request('/api/closings', { closingDate: date });
  const detail = await request(`/api/closing-details?date=${date}`, undefined, 'GET');
  const row = detail.body[0];
  assert.equal(closing.status, 201);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(row.opening_stock + row.entries - row.exits - row.sales + row.adjustments + row.returns, row.closing_stock);
  assert.equal(row.entries, 14);
  assert.equal(row.sales, 2);
  assert.equal(row.adjustments, -1);
  assert.equal(row.closing_stock, 11);
  assert.equal((await request('/api/closings', undefined, 'GET')).body[0].actor_name, 'Administrador de prueba');
  const lateOperation = await request('/api/sync', { operations: [{
    id: 'movement-after-close', kind: 'movement',
    payload: { productId, kind: 'ENTRY', quantity: 1, operatingDate: date },
  }] });
  assert.equal(lateOperation.body.results[0].ok, false);
  assert.match(lateOperation.body.results[0].error, /cerrado/);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 11);
});

test('rechaza fechas imposibles y evita guardar precios inválidos al editar', async () => {
  const { productId } = await fixture();
  const invalidDate = await request('/api/closings', { closingDate: '2026-02-31' });
  const invalidEdit = await request(`/api/products/${productId}`, {
    code: 'D-001', name: 'Cambio inválido', unit: 'unidad', price: -4,
  }, 'PUT');
  const product = (await request('/api/products', undefined, 'GET')).body[0];
  assert.equal(invalidDate.status, 422);
  assert.equal(invalidEdit.status, 422);
  assert.equal(product.name, 'Producto de prueba');
  assert.equal(product.price, 15);
});

test('el reporte de actividad separa ventas de movimientos sin ventas', async () => {
  const { productId, clientId, date } = await fixture();
  await request('/api/sync', { operations: [{
    id: 'rotation-sale-001', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 2 }] },
  }] });
  const report = await request(`/api/reports/rotation?from=${date}&to=${date}`, undefined, 'GET');
  assert.equal(report.body.length, 1);
  assert.equal(report.body[0].sold, 2);
  assert.equal(report.body[0].stock, 8);
  assert.equal(report.body[0].last_sale, date);
  const exportHeaders = { Cookie: admin.cookie, 'X-DRESA-Device': admin.deviceId };
  const exported = await fetch(`${base}/api/export?resource=rotation&from=${date}&to=${date}`, { headers: exportHeaders });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  const productsExport = await fetch(`${base}/api/export?resource=products`, { headers: exportHeaders });
  assert.equal(productsExport.status, 200);
  assert.match(productsExport.headers.get('content-disposition'), /dresa-products\.csv/);
  const invalid = await request(`/api/reports/rotation?from=${date}&to=2020-01-01`, undefined, 'GET');
  assert.equal(invalid.status, 422);
});

test('no se pueden registrar movimientos con fecha futura y el producto admite desactivarse', async () => {
  const { productId } = await fixture();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const future = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const movement = await request('/api/sync', { operations: [{
    id: 'movement-future-001', kind: 'movement',
    payload: { productId, kind: 'ENTRY', quantity: 2, operatingDate: future },
  }] });
  assert.equal(movement.body.results[0].ok, false);
  assert.match(movement.body.results[0].error, /fecha futura/);
  const product = await request(`/api/products/${productId}`, {
    code: 'D-001', name: 'Producto de prueba', unit: 'unidad', price: 15, active: '0',
  }, 'PUT');
  assert.equal(product.status, 200);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].active, 0);
});

test('el bootstrap crea un administrador con contraseña derivada y se consume una sola vez', async () => {
  const user = db.prepare("SELECT username, role_id, password_hash FROM users WHERE username = 'admin'").get();
  assert.equal(user.role_id, 'ADMIN');
  assert.match(user.password_hash, /^scrypt\$32768\$/);
  assert.equal(user.password_hash.includes('Secure-test-password-2026'), false);
  assert.equal((await request('/api/auth/status', undefined, 'GET', null)).body.setupRequired, false);
  const deviceId = randomUUID();
  const secondBootstrap = await request('/api/auth/bootstrap', {
    bootstrapToken, name: 'Segundo administrador', username: 'second', password: 'Another-safe-password-2026',
    deviceId, deviceName: 'Otra matriz',
  }, 'POST', null);
  assert.equal(secondBootstrap.status, 409);
  const forwardedHttpsBootstrap = await fetch(`${base}/api/auth/bootstrap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DRESA-Device': deviceId,
      Origin: `https://${new URL(base).host}`,
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({
      bootstrapToken, name: 'Segundo administrador', username: 'second', password: 'Another-safe-password-2026',
      deviceId, deviceName: 'Otra matriz',
    }),
  });
  assert.equal(forwardedHttpsBootstrap.status, 409);
  assert.equal((await forwardedHttpsBootstrap.json()).code, 'ALREADY_CONFIGURED');
});

test('la API niega acceso sin sesión y comprueba origen y dispositivo ligado', async () => {
  const unauthorized = await request('/api/inventory', undefined, 'GET', null);
  assert.equal(unauthorized.status, 401);
  const staticPage = await fetch(`${base}/`);
  assert.equal(staticPage.status, 200);
  const wrongDevice = await fetch(`${base}/api/products`, {
    headers: { Cookie: admin.cookie, 'X-DRESA-Device': randomUUID() },
  });
  assert.equal(wrongDevice.status, 403);
  const crossSite = await fetch(`${base}/api/closings`, {
    method: 'POST',
    headers: { Cookie: admin.cookie, 'X-DRESA-Device': admin.deviceId, Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ closingDate: new Date().toLocaleDateString('en-CA') }),
  });
  assert.equal(crossSite.status, 403);
  const missingCsrf = await fetch(`${base}/api/closings`, {
    method: 'POST',
    headers: { Cookie: admin.cookie, 'X-DRESA-Device': admin.deviceId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ closingDate: new Date().toLocaleDateString('en-CA') }),
  });
  assert.equal(missingCsrf.status, 403);
});

test('login rechaza contraseñas incorrectas, logout revoca la sesión y las sesiones vencidas no dan acceso', async () => {
  const user = await createAccount('security-lifecycle');
  const deviceId = randomUUID();
  const credentials = {
    username: user.username, password: 'incorrect-password',
    deviceId, deviceName: 'Dispositivo de prueba',
  };
  const wrongPassword = await request('/api/auth/login', credentials, 'POST', null);
  assert.equal(wrongPassword.status, 401);
  const seller = await enrollDevice(user);
  const me = await request('/api/auth/me', undefined, 'GET', seller);
  assert.equal(me.status, 200);
  assert.equal(JSON.stringify(me.body).includes('password_hash'), false);
  assert.equal(JSON.stringify(me.body).includes('Safe-password-for-test-2026'), false);
  const sessionList = await request('/api/admin/sessions', undefined, 'GET');
  assert.equal(JSON.stringify(sessionList.body).includes('token_hash'), false);
  const missingCsrfLogout = await request('/api/auth/logout', {}, 'POST', { ...seller, csrfToken: '' });
  assert.equal(missingCsrfLogout.status, 403);
  const wrongDeviceLogout = await request('/api/auth/logout', {}, 'POST', { ...seller, deviceId: randomUUID() });
  assert.equal(wrongDeviceLogout.status, 403);
  const logout = await request('/api/auth/logout', {}, 'POST', seller);
  assert.equal(logout.status, 200);
  assert.equal((await request('/api/products', undefined, 'GET', seller)).status, 401);

  const relogin = await request('/api/auth/login', {
    username: user.username, password: 'Safe-password-for-test-2026',
    deviceId: seller.deviceId, deviceName: 'Dispositivo de prueba',
  }, 'POST', null);
  assert.equal(relogin.status, 200);
  const activeSeller = { cookie: relogin.setCookie.split(';')[0], deviceId: seller.deviceId, csrfToken: relogin.body.csrfToken };
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?")
    .run(user.id);
  assert.equal((await request('/api/auth/me', undefined, 'GET', activeSeller)).status, 401);
  assert.equal((await request('/api/products', undefined, 'GET', activeSeller)).status, 401);
});

test('usuarios de ruta heredados sin asignación no pueden iniciar sesión hasta recibir alcance válido', async () => {
  const user = await createAccount('legacy-unassigned');
  db.prepare('UPDATE users SET route_id = NULL WHERE id = ?').run(user.id);
  const login = await request('/api/auth/login', {
    username: user.username, password: 'Safe-password-for-test-2026',
    deviceId: randomUUID(), deviceName: 'Dispositivo sin ruta',
  }, 'POST', null);
  assert.equal(login.status, 403);
  assert.equal(login.body.code, 'ROUTE_NOT_ASSIGNED');
});

test('ADMIN no puede alterar sus propios permisos o estado ni obtener hashes mediante la API', async () => {
  const ownPermissions = await request(`/api/admin/users/${admin.userId}`, {
    role: 'VENDEDOR', routeId: 'route-001',
  }, 'PATCH');
  const ownStatus = await request(`/api/admin/users/${admin.userId}`, { active: false }, 'PATCH');
  assert.equal(ownPermissions.status, 403);
  assert.equal(ownPermissions.body.code, 'SELF_PERMISSION_CHANGE');
  assert.equal(ownStatus.status, 403);
  const invalidStatus = await request(`/api/admin/users/${admin.userId}`, { active: 'enabled' }, 'PATCH');
  assert.equal(invalidStatus.status, 422);
  const account = db.prepare('SELECT role_id, active, password_hash FROM users WHERE id = ?').get(admin.userId);
  assert.equal(account.role_id, 'ADMIN');
  assert.equal(account.active, 1);
  const users = await request('/api/admin/users', undefined, 'GET');
  assert.equal(users.status, 200);
  assert.equal(JSON.stringify(users.body).includes('password_hash'), false);
  assert.equal(JSON.stringify(users.body).includes(account.password_hash), false);
});

test('la matriz conserva y consulta auditoría de cambios de cuenta, solicitudes de dispositivo y accesos', async () => {
  const user = await createAccount('audited-user');
  const seller = await enrollDevice(user);
  assert.equal((await request('/api/admin/security-events', undefined, 'GET', seller)).status, 403);
  const passwordReset = await request(`/api/admin/users/${user.id}/password`, {
    password: 'Replacement-password-2026',
  }, 'PUT');
  assert.equal(passwordReset.status, 200);
  const events = await request('/api/admin/security-events', undefined, 'GET');
  assert.equal(events.status, 200);
  assert.ok(events.body.some((event) =>
    event.event_type === 'USER_CREATED' && event.actor_user_id === admin.userId &&
    event.subject_user_id === user.id && event.details.role === 'VENDEDOR' &&
    event.details.routeId === 'route-001'));
  assert.ok(events.body.some((event) =>
    event.event_type === 'DEVICE_AUTHORIZATION_REQUESTED' && event.subject_user_id === user.id));
  assert.ok(events.body.some((event) =>
    event.event_type === 'DEVICE_APPROVED' && event.subject_user_id === user.id));
  assert.ok(events.body.some((event) =>
    event.event_type === 'LOGIN_SUCCEEDED' && event.subject_user_id === user.id));
  assert.ok(events.body.some((event) =>
    event.event_type === 'USER_PASSWORD_RESET' && event.actor_user_id === admin.userId));
  const encoded = JSON.stringify(events.body);
  assert.equal(encoded.includes('Replacement-password-2026'), false);
  assert.equal(encoded.includes('password_hash'), false);
});

test('VENDEDOR puede trabajar con clientes y ventas, pero no acceder a administración', async () => {
  const { productId, clientId, date } = await fixture();
  const user = await createAccount('seller', 'VENDEDOR');
  const seller = await enrollDevice(user);
  const inactiveProduct = await request('/api/products', {
    code: 'D-INACTIVE', name: 'No disponible', unit: 'unidad', price: 10, stock: 0, active: '0',
  });
  assert.equal(inactiveProduct.status, 201);
  const products = await request('/api/products', undefined, 'GET', seller);
  const clients = await request('/api/clients', undefined, 'GET', seller);
  const inventory = await request('/api/inventory', undefined, 'GET', seller);
  const users = await request('/api/admin/users', undefined, 'GET', seller);
  const audit = await request('/api/admin/security-events', undefined, 'GET', seller);
  const createProduct = await request('/api/products', {
    code: 'SELLER-EDIT', name: 'No autorizado', unit: 'unidad', price: 99, stock: 0,
  }, 'POST', seller);
  const changePrice = await request('/api/products/product-id', { price: 0 }, 'PUT', seller);
  const inventoryWrite = await request('/api/sync', { operations: [{
    id: 'seller-inventory-tamper', kind: 'movement',
    payload: { productId, kind: 'ENTRY', quantity: 10, operatingDate: date },
  }] }, 'POST', seller);
  assert.equal(products.status, 200);
  assert.equal(products.body.length, 1);
  assert.equal(products.body[0].active, 1);
  assert.equal(clients.status, 200);
  assert.equal(inventory.status, 403);
  assert.equal(users.status, 403);
  assert.equal(audit.status, 403);
  assert.equal(createProduct.status, 403);
  assert.equal(changePrice.status, 403);
  assert.equal(inventoryWrite.status, 403);
  const operation = {
    id: 'seller-offline-sale-001', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 1 }] },
  };
  const firstSync = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  const retriedSync = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  assert.equal(firstSync.body.results[0].ok, true);
  assert.equal(retriedSync.body.results[0].result.duplicate, true);
  assert.equal((await request('/api/products', undefined, 'GET')).body.find((product) => product.id === productId).stock, 9);
  const [sale] = (await request('/api/sales', undefined, 'GET')).body;
  assert.equal(sale.created_by, user.id);
  assert.equal(sale.seller_name, user.name);
  const saleMovement = (await request('/api/movements', undefined, 'GET')).body.find((row) => row.sale_id === operation.id);
  assert.equal(saleMovement.actor_name, user.name);
});

test('Mis operaciones carga el historial sincronizado vinculado al vendedor en una sesión nueva', async () => {
  const { productId, clientId, date } = await fixture();
  const user = await createAccount('seller-history-persistent');
  const seller = await enrollDevice(user);
  const operationId = 'seller-history-persistent-sale';
  const payload = {
    clientId, kind: 'AUTOVENTA', operatingDate: date,
    reference: 'Pedido sincronizado', lines: [{ productId, quantity: 1 }],
  };
  const synced = await request('/api/sync', {
    operations: [{ id: operationId, kind: 'sale', payload }],
  }, 'POST', seller);
  assert.equal(synced.body.results[0].ok, true);
  const history = await request('/api/my/sales', undefined, 'GET', seller);
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0].id, operationId);
  assert.equal(history.body[0].created_by, user.id);
  assert.equal(history.body[0].reference, payload.reference);
  assert.equal(history.body[0].total, 15);
  assert.equal(history.body[0].status, 'COMPLETED');
  const logout = await request('/api/auth/logout', {}, 'POST', seller);
  assert.equal(logout.status, 200);
  const relogin = await request('/api/auth/login', {
    username: user.username, password: 'Safe-password-for-test-2026',
    deviceId: seller.deviceId, deviceName: 'Dispositivo seller',
  }, 'POST', null);
  assert.equal(relogin.status, 200);
  const newSession = {
    cookie: relogin.setCookie.split(';')[0], deviceId: seller.deviceId, csrfToken: relogin.body.csrfToken,
  };
  const afterRestart = await request('/api/my/sales', undefined, 'GET', newSession);
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.body.length, 1);
  assert.equal(afterRestart.body[0].id, operationId);
});

test('el historial y los reportes incluyen operaciones más allá del límite histórico anterior', async () => {
  const { productId, clientId, date } = await fixture();
  const user = await createAccount('seller-full-history');
  const seller = await enrollDevice(user);
  const timestamp = `${date}T12:00:00.000Z`;
  db.prepare(`WITH RECURSIVE numbers(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 5001
    )
    INSERT INTO sales (id, client_id, kind, status, operating_date, occurred_at, reference, created_by, created_at)
    SELECT 'history-complete-' || value, ?, 'AUTOVENTA', 'COMPLETED', ?, ?, '', ?, ? FROM numbers`)
    .run(clientId, date, timestamp, user.id, timestamp);
  const warehouseId = db.prepare("SELECT warehouse_id FROM routes WHERE id = 'route-001'").get().warehouse_id;
  db.prepare(`WITH RECURSIVE numbers(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 501
    )
    INSERT INTO inventory_movements
      (id, product_id, warehouse_id, kind, quantity_delta, note, operating_date, created_by, created_at)
    SELECT 'movement-history-' || value, ?, ?, 'ENTRY', 0.001, '', ?, ?, ? FROM numbers`)
    .run(productId, warehouseId, date, user.id, timestamp);

  const matrixHistory = await request('/api/sales', undefined, 'GET');
  const sellerHistory = await request('/api/my/sales', undefined, 'GET', seller);
  const report = await request(`/api/reports/sales?from=${date}&to=${date}`, undefined, 'GET');
  assert.equal(matrixHistory.body.length, 5001);
  assert.equal(sellerHistory.body.length, 5001);
  assert.equal(report.body.length, 5001);
  const movementHistory = await request('/api/movements', undefined, 'GET');
  assert.equal(movementHistory.body.length, 502);
});

test('el inventario mantiene saldo total y saldos separados por bodega para movimientos y ventas', async () => {
  const { productId, clientId, date } = await fixture();
  const otherWarehouse = await request('/api/admin/warehouses', {
    code: 'WH-SECOND', name: 'Bodega segunda',
  });
  assert.equal(otherWarehouse.status, 201);
  assert.equal((await request('/api/admin/routes', {
    id: 'route-002', name: 'Ruta 002', warehouseId: otherWarehouse.body.id, active: true,
  })).status, 201);
  const secondEntry = await request('/api/sync', { operations: [{
    id: 'warehouse-entry-2', kind: 'movement',
    payload: { productId, kind: 'ENTRY', quantity: 4, warehouseId: otherWarehouse.body.id, operatingDate: date },
  }] });
  assert.equal(secondEntry.body.results[0].ok, true);
  const mainInventory = await request('/api/inventory?warehouseId=' + encodeURIComponent(
    db.prepare("SELECT warehouse_id FROM routes WHERE id = 'route-001'").get().warehouse_id,
  ), undefined, 'GET');
  const secondInventory = await request(`/api/inventory?warehouseId=${otherWarehouse.body.id}`, undefined, 'GET');
  assert.equal(mainInventory.body.find((row) => row.id === productId).stock, 10);
  assert.equal(secondInventory.body.find((row) => row.id === productId).stock, 4);
  assert.equal((await request('/api/products', undefined, 'GET')).body.find((row) => row.id === productId).stock, 14);

  const sellerUser = await createAccount('warehouse-autosale');
  const seller = await enrollDevice(sellerUser);
  const sellerProducts = await request('/api/products', undefined, 'GET', seller);
  assert.equal(sellerProducts.body.find((row) => row.id === productId).stock, 10);
  const sale = await request('/api/sync', { operations: [{
    id: 'warehouse-autosale-1', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 2 }] },
  }] }, 'POST', seller);
  assert.equal(sale.body.results[0].ok, true);
  const mainAfterSale = await request('/api/inventory?warehouseId=' + encodeURIComponent(
    db.prepare("SELECT warehouse_id FROM routes WHERE id = 'route-001'").get().warehouse_id,
  ), undefined, 'GET');
  const secondAfterSale = await request(`/api/inventory?warehouseId=${otherWarehouse.body.id}`, undefined, 'GET');
  assert.equal(mainAfterSale.body.find((row) => row.id === productId).stock, 8);
  assert.equal(secondAfterSale.body.find((row) => row.id === productId).stock, 4);
  assert.equal((await request('/api/products', undefined, 'GET')).body.find((row) => row.id === productId).stock, 12);
  const sellerProductsAfterSale = await request('/api/products', undefined, 'GET', seller);
  assert.equal(sellerProductsAfterSale.body.find((row) => row.id === productId).stock, 8);
});

test('reportes de venta filtran por rango, vendedor, ruta, cliente y producto', async () => {
  const { productId, clientId, date } = await fixture();
  const user = await createAccount('sales-report-seller');
  const seller = await enrollDevice(user);
  const operation = await request('/api/sync', { operations: [{
    id: 'reportable-sale', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, reference: 'Reporte prueba', lines: [{ productId, quantity: 1 }] },
  }] }, 'POST', seller);
  assert.equal(operation.body.results[0].ok, true);
  const report = await request(`/api/reports/sales?from=${date}&to=${date}&sellerId=${user.id}&routeId=route-001&clientId=${clientId}&productId=${productId}`, undefined, 'GET');
  assert.equal(report.status, 200);
  assert.equal(report.body.length, 1);
  assert.equal(report.body[0].id, 'reportable-sale');
  assert.equal(report.body[0].route_name, 'Ruta 001');
  assert.equal(report.body[0].reference, 'Reporte prueba');
  const denied = await request('/api/reports/sales', undefined, 'GET', seller);
  assert.equal(denied.status, 403);
});

test('PREVENTA puede registrar pedidos y clientes, pero no autoventas', async () => {
  const { productId, clientId, date } = await fixture();
  const user = await createAccount('preorder', 'PREVENTA');
  const seller = await enrollDevice(user);
  const automaticSale = await request('/api/sync', { operations: [{
    id: 'preventa-denied-auto', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 1 }] },
  }] }, 'POST', seller);
  assert.equal(automaticSale.status, 403);
  const preorder = await request('/api/sync', { operations: [{
    id: 'preventa-allowed-order', kind: 'sale',
    payload: { clientId, kind: 'PREVENTA', operatingDate: date, lines: [{ productId, quantity: 2 }] },
  }] }, 'POST', seller);
  assert.equal(preorder.body.results[0].ok, true);
  assert.equal(preorder.body.results[0].result.status, 'PENDING');
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
});

test('un dispositivo nuevo requiere autorización; autorizarlo revoca el anterior y bloquearlo cierra sesión', async () => {
  const user = await createAccount('device-user');
  const first = await enrollDevice(user);
  const secondId = randomUUID();
  const credentials = {
    username: user.username, password: 'Safe-password-for-test-2026',
    deviceId: secondId, deviceName: 'Teléfono nuevo',
  };
  const pending = await request('/api/auth/login', credentials, 'POST', null);
  assert.equal(pending.body.code, 'DEVICE_PENDING');
  const approve = await request(`/api/admin/users/${user.id}/devices/${secondId}/approve`, { revokePrevious: true });
  assert.equal(approve.status, 200);
  const secondLogin = await request('/api/auth/login', credentials, 'POST', null);
  const second = { cookie: secondLogin.setCookie.split(';')[0], deviceId: secondId, csrfToken: secondLogin.body.csrfToken };
  assert.equal(secondLogin.status, 200);
  const firstSession = await request('/api/auth/me', undefined, 'GET', first);
  assert.equal(firstSession.status, 401);
  assert.equal((await request('/api/auth/me', undefined, 'GET', second)).status, 200);
  assert.equal((await request(`/api/admin/users/${user.id}/devices/${secondId}/block`, {}, 'POST')).status, 200);
  assert.equal((await request('/api/auth/me', undefined, 'GET', second)).status, 401);
  const blockedLogin = await request('/api/auth/login', credentials, 'POST', null);
  assert.equal(blockedLogin.status, 403);
  assert.equal(blockedLogin.body.code, 'DEVICE_BLOCKED');
});

test('no permite dos sesiones simultáneas del usuario en dispositivos distintos', async () => {
  const user = await createAccount('single-session');
  const first = await enrollDevice(user);
  const secondId = randomUUID();
  const credentials = {
    username: user.username, password: 'Safe-password-for-test-2026',
    deviceId: secondId, deviceName: 'Segundo dispositivo',
  };
  await request('/api/auth/login', credentials, 'POST', null);
  await request(`/api/admin/users/${user.id}/devices/${secondId}/approve`, { revokePrevious: false });
  const competingLogin = await request('/api/auth/login', credentials, 'POST', null);
  assert.equal(competingLogin.status, 409);
  assert.equal(competingLogin.body.code, 'ACTIVE_SESSION');
  assert.equal((await request('/api/auth/me', undefined, 'GET', first)).status, 200);
});

test('la matriz puede revocar una sesión activa individualmente', async () => {
  const user = await createAccount('session-revocation');
  const seller = await enrollDevice(user);
  const sessions = await request('/api/admin/sessions', undefined, 'GET');
  const session = sessions.body.find((item) => item.username === user.username);
  assert.ok(session);
  const revoke = await request(`/api/admin/sessions/${session.id}/revoke`, {}, 'POST');
  assert.equal(revoke.status, 200);
  assert.equal((await request('/api/products', undefined, 'GET', seller)).status, 401);
});

test('desactivar un usuario bloquea su sesión y restablecer contraseña invalida sesiones', async () => {
  const user = await createAccount('disable-user');
  const seller = await enrollDevice(user);
  const disabled = await request(`/api/admin/users/${user.id}`, { active: false }, 'PATCH');
  assert.equal(disabled.status, 200);
  assert.equal((await request('/api/products', undefined, 'GET', seller)).status, 401);
  const inactiveLogin = await request('/api/auth/login', {
    username: user.username, password: 'Safe-password-for-test-2026',
    deviceId: seller.deviceId, deviceName: 'Dispositivo seller',
  }, 'POST', null);
  assert.equal(inactiveLogin.status, 401);
  await request(`/api/admin/users/${user.id}`, { active: true }, 'PATCH');
  const login = await request('/api/auth/login', {
    username: user.username, password: 'Safe-password-for-test-2026',
    deviceId: seller.deviceId, deviceName: 'Dispositivo seller',
  }, 'POST', null);
  const activeSeller = { cookie: login.setCookie.split(';')[0], deviceId: seller.deviceId, csrfToken: login.body.csrfToken };
  const reset = await request(`/api/admin/users/${user.id}/password`, { password: 'New-safe-password-2026' }, 'PUT');
  assert.equal(reset.status, 200);
  assert.equal((await request('/api/products', undefined, 'GET', activeSeller)).status, 401);
  const newLogin = await request('/api/auth/login', {
    username: user.username, password: 'New-safe-password-2026',
    deviceId: seller.deviceId, deviceName: 'Dispositivo seller',
  }, 'POST', null);
  assert.equal(newLogin.status, 200);
});

test('sirve la matriz y la aplicación móvil desde el mismo servidor', async () => {
  const matrix = await fetch(`${base}/`);
  const seller = await fetch(`${base}/vendedor`);
  assert.equal(matrix.status, 200);
  assert.equal(seller.status, 200);
  const matrixMarkup = await matrix.text();
  const sellerMarkup = await seller.text();
  assert.match(matrixMarkup, /Historial de seguridad/);
  assert.match(matrixMarkup, /app\.js\?v=18/);
  assert.match(sellerMarkup, /Registrar venta/);

  const user = await createAccount('mobile-page-seller');
  const authorizedSeller = await enrollDevice(user);
  const authenticatedPage = await fetch(`${base}/vendedor`, {
    headers: {
      Cookie: authorizedSeller.cookie,
      'X-DRESA-Device': authorizedSeller.deviceId,
    },
  });
  assert.equal(authenticatedPage.status, 200);
  assert.match(await authenticatedPage.text(), /Registrar venta/);
  for (const asset of ['/app.js?v=18', '/styles.css?v=5', '/sw.js']) {
    const response = await fetch(`${base}${asset}`, {
      headers: {
        Cookie: authorizedSeller.cookie,
        'X-DRESA-Device': authorizedSeller.deviceId,
      },
    });
    assert.equal(response.status, 200, `${asset} debe estar disponible para el vendedor autenticado`);
  }
});

test('dos vendedores que compiten por el stock no pueden vender unidades de más', async () => {
  const { productId, clientId, date } = await fixture();
  const sellers = await Promise.all([
    createAccount('stock-seller-a').then(enrollDevice),
    createAccount('stock-seller-b').then(enrollDevice),
  ]);
  const operations = sellers.map((seller, index) => request('/api/sync', { operations: [{
    id: `concurrent-sale-${index}`, kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 7 }] },
  }] }, 'POST', seller));
  const results = await Promise.all(operations);
  assert.deepEqual(results.map((response) => response.body.results[0].ok).sort(), [false, true]);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 3);
  assert.equal((await request('/api/sales', undefined, 'GET')).body.length, 1);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.filter((row) => row.kind === 'SALE').length, 1);
});

test('el precio de matriz aplica a ventas posteriores y conserva el precio ya vendido', async () => {
  const { productId, clientId, date } = await fixture();
  const oldPriceVersion = (await request('/api/products', undefined, 'GET')).body
    .find((product) => product.id === productId).price_version;
  const beforePriceChange = new Date().toISOString();
  const updated = await request(`/api/products/${productId}`, {
    code: 'D-001', name: 'Producto de prueba', unit: 'unidad', price: 22.5, active: 1,
  }, 'PUT');
  assert.equal(updated.status, 200);
  const delayedOfflineSale = await request('/api/sync', { operations: [{
    id: 'sale-before-price-change', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, occurredAt: beforePriceChange,
      lines: [{ productId, quantity: 1, unitPrice: 15, priceVersion: oldPriceVersion }] },
  }] });
  assert.equal(delayedOfflineSale.body.results[0].ok, true, JSON.stringify(delayedOfflineSale.body.results[0]));
  const currentPriceVersion = (await request('/api/products', undefined, 'GET')).body
    .find((product) => product.id === productId).price_version;
  const afterPriceChange = new Date().toISOString();
  const second = await request('/api/sync', { operations: [{
    id: 'sale-after-price-change', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, occurredAt: afterPriceChange,
      lines: [{ productId, quantity: 1, unitPrice: 22.5, priceVersion: currentPriceVersion }] },
  }] });
  assert.equal(second.body.results[0].ok, true);
  const tampered = await request('/api/sync', { operations: [{
    id: 'sale-tampered-price', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, occurredAt: afterPriceChange,
      lines: [{ productId, quantity: 1, unitPrice: 1, priceVersion: currentPriceVersion }] },
  }] });
  assert.equal(tampered.body.results[0].ok, false);
  assert.match(tampered.body.results[0].error, /precio .* cambió/i);
  const staleQuote = await request('/api/sync', { operations: [{
    id: 'sale-stale-price-quote', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, occurredAt: afterPriceChange,
      lines: [{ productId, quantity: 1, unitPrice: 15, priceVersion: oldPriceVersion }] },
  }] });
  assert.equal(staleQuote.body.results[0].ok, false);
  assert.match(staleQuote.body.results[0].error, /cotización .* ya no estaba vigente/i);
  const unversionedHistoricalPrice = await request('/api/sync', { operations: [{
    id: 'sale-unversioned-historical-price', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, occurredAt: beforePriceChange,
      lines: [{ productId, quantity: 1, unitPrice: 15 }] },
  }] });
  assert.equal(unversionedHistoricalPrice.body.results[0].ok, false);
  const sales = (await request('/api/sales', undefined, 'GET')).body;
  assert.equal(sales.find((sale) => sale.id === 'sale-before-price-change').total, 15);
  assert.equal(sales.find((sale) => sale.id === 'sale-after-price-change').total, 22.5);
  assert.equal(sales.length, 2);
});

test('rechaza una hora retroactiva que no coincide con la fecha operativa', async () => {
  const { productId, clientId, date } = await fixture();
  const previousDate = new Date(`${date}T12:00:00`).getTime() - 24 * 60 * 60 * 1000;
  const result = await request('/api/sync', { operations: [{
    id: 'sale-backdated-outside-operating-date', kind: 'sale',
    payload: {
      clientId, kind: 'AUTOVENTA', operatingDate: date, occurredAt: new Date(previousDate).toISOString(),
      lines: [{ productId, quantity: 1, unitPrice: 15 }],
    },
  }] });
  assert.equal(result.body.results[0].ok, false);
  assert.match(result.body.results[0].error, /fecha y hora .* no coinciden/i);
  assert.equal((await request('/api/sales', undefined, 'GET')).body.length, 0);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 10);
});

test('la matriz puede desactivar clientes sin borrar su historial y los vendedores no pueden hacerlo', async () => {
  const { productId, clientId, date } = await fixture();
  await request('/api/sync', { operations: [{
    id: 'client-history-sale', kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 1 }] },
  }] });
  const user = await createAccount('client-access-check');
  const seller = await enrollDevice(user);
  const forbidden = await request(`/api/clients/${clientId}`, { active: false }, 'PATCH', seller);
  assert.equal(forbidden.status, 403);
  const deactivated = await request(`/api/clients/${clientId}`, { active: false }, 'PATCH');
  assert.equal(deactivated.status, 200);
  const matrixClients = await request('/api/clients', undefined, 'GET');
  assert.equal(matrixClients.body.length, 1);
  assert.equal(matrixClients.body[0].active, 0);
  const sellerClients = await request('/api/clients', undefined, 'GET', seller);
  assert.equal(sellerClients.body.length, 0);
  const sales = await request('/api/sales', undefined, 'GET');
  assert.equal(sales.body.length, 1);
  assert.equal(sales.body[0].client_name, 'Tienda central');
});

test('la ficha de cliente se crea, edita y consulta con sus datos operativos completos', async () => {
  const id = 'complete-client-record-001';
  const create = await request('/api/sync', { operations: [{
    id, kind: 'client',
    payload: {
      taxId: '0801-1990-12345',
      fullName: 'María López',
      businessName: 'Abarrotería El Centro',
      phone: '2222-1234',
      email: 'contacto@elcentro.example',
      address: 'Avenida Central, local 4',
      reference: 'Frente al parque',
      routeId: 'route-001',
      notes: 'Contacto: María. Atender 8:00 a 16:00; pago contra entrega.',
      latitude: '14.0722',
      longitude: '-87.1921',
    },
  }] });
  assert.equal(create.body.results[0].ok, true);
  const before = await request('/api/clients', undefined, 'GET');
  const client = before.body.find((row) => row.id === id);
  assert.equal(client.tax_id, '0801-1990-12345');
  assert.equal(client.full_name, 'María López');
  assert.equal(client.business_name, 'Abarrotería El Centro');
  assert.equal(client.name, 'Abarrotería El Centro');
  assert.equal(client.email, 'contacto@elcentro.example');
  assert.equal(client.address, 'Avenida Central, local 4');
  assert.equal(client.reference, 'Frente al parque');
  assert.equal(client.route_id, 'route-001');
  assert.equal(client.notes, 'Contacto: María. Atender 8:00 a 16:00; pago contra entrega.');

  const updated = await request(`/api/clients/${id}`, {
    taxId: '0801-1990-12345',
    fullName: 'María Elena López',
    businessName: 'Abarrotería El Centro',
    phone: '2222-9999',
    email: 'ventas@elcentro.example',
    address: 'Avenida Central, local 5',
    reference: 'Portón azul',
    routeId: 'route-001',
    notes: 'Recibe pedidos hasta las 15:00.',
    latitude: '14.0723',
    longitude: '-87.1922',
    active: true,
  }, 'PUT');
  assert.equal(updated.status, 200);
  const after = (await request('/api/clients', undefined, 'GET')).body.find((row) => row.id === id);
  assert.equal(after.full_name, 'María Elena López');
  assert.equal(after.phone, '2222-9999');
  assert.equal(after.reference, 'Portón azul');
  assert.equal(after.notes, 'Recibe pedidos hasta las 15:00.');
  const searchedClient = await request('/api/clients?q=ventas%40elcentro', undefined, 'GET');
  assert.equal(searchedClient.status, 200);
  assert.equal(searchedClient.body.length, 1);
  assert.equal(searchedClient.body[0].id, id);

  const invalid = await request(`/api/clients/${id}`, {
    fullName: 'María Elena López', businessName: 'Abarrotería El Centro', email: 'correo-inválido',
  }, 'PUT');
  assert.equal(invalid.status, 422);
  const unchanged = (await request('/api/clients', undefined, 'GET')).body.find((row) => row.id === id);
  assert.equal(unchanged.email, 'ventas@elcentro.example');

  const sellerUser = await createAccount('client-record-seller');
  const seller = await enrollDevice(sellerUser);
  const visibleToSeller = await request('/api/clients', undefined, 'GET', seller);
  assert.equal(visibleToSeller.body.find((row) => row.id === id).notes, 'Recibe pedidos hasta las 15:00.');
  const forbiddenEdit = await request(`/api/clients/${id}`, { notes: 'Cambio no permitido' }, 'PUT', seller);
  assert.equal(forbiddenEdit.status, 403);
});

test('el conflicto de stock queda visible a matriz y la operación original se sincroniza una sola vez al resolverlo', async () => {
  const { productId, clientId, date } = await fixture();
  const user = await createAccount('conflict-review-seller');
  const seller = await enrollDevice(user);
  const operation = {
    id: 'stock-conflict-review-001',
    kind: 'sale',
    payload: { clientId, kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 11 }] },
  };
  const rejected = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  assert.equal(rejected.body.results[0].ok, false);
  const conflicts = await request('/api/admin/sync-conflicts', undefined, 'GET');
  assert.equal(conflicts.body.length, 1);
  assert.equal(conflicts.body[0].operation_id, operation.id);
  assert.equal(conflicts.body[0].username, user.username);
  assert.equal(conflicts.body[0].attempts, 1);
  const repeatedRejection = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  assert.equal(repeatedRejection.body.results[0].ok, false);
  assert.equal((await request('/api/admin/sync-conflicts', undefined, 'GET')).body[0].attempts, 2);

  await request('/api/sync', { operations: [{
    id: 'stock-conflict-replenishment-001', kind: 'movement',
    payload: { productId, kind: 'ENTRY', quantity: 2,
      warehouseId: db.prepare("SELECT warehouse_id FROM routes WHERE id = 'route-001'").get().warehouse_id,
      operatingDate: date },
  }] });
  const accepted = await request('/api/sync', { operations: [operation] }, 'POST', seller);
  assert.equal(accepted.body.results[0].ok, true);
  assert.equal((await request('/api/admin/sync-conflicts', undefined, 'GET')).body.length, 0);
  assert.equal((await request('/api/products', undefined, 'GET')).body[0].stock, 1);
  assert.equal((await request('/api/sales', undefined, 'GET')).body.length, 1);
  assert.equal((await request('/api/movements', undefined, 'GET')).body.filter((row) => row.sale_id === operation.id).length, 1);
});

test('ADMIN administra bodegas y rutas sin borrar historial y los usuarios se asignan solo a rutas operativas', async () => {
  const unassigned = await request('/api/admin/users', {
    name: 'Vendedor sin ruta', username: 'seller-no-route', role: 'VENDEDOR',
    password: 'Safe-password-for-test-2026',
  });
  assert.equal(unassigned.status, 422);
  const otherWarehouse = await request('/api/admin/warehouses', { code: 'TEST-002', name: 'Bodega ruta dos' });
  assert.equal(otherWarehouse.status, 201);
  const route = await request('/api/admin/routes', {
    id: 'route-002', name: 'Ruta 002', warehouseId: otherWarehouse.body.id, active: true,
  });
  assert.equal(route.status, 201);
  const routes = await request('/api/admin/routes', undefined, 'GET');
  assert.equal(routes.status, 200);
  assert.equal(routes.body.length, 2);
  const sellerUser = await createAccount('route-two-seller');
  const originalSession = await enrollDevice(sellerUser);
  const assigned = await request(`/api/admin/users/${sellerUser.id}`, { routeId: 'route-002' }, 'PATCH');
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.routeId, 'route-002');
  assert.equal((await request('/api/auth/me', undefined, 'GET', originalSession)).status, 401);
  const forbiddenDisableRoute = await request('/api/admin/routes/route-002', {
    name: 'Ruta 002', warehouseId: otherWarehouse.body.id, active: false,
  }, 'PUT');
  assert.equal(forbiddenDisableRoute.status, 422);
  const forbiddenDisableWarehouse = await request(`/api/admin/warehouses/${otherWarehouse.body.id}`, {
    code: 'TEST-002', name: 'Bodega ruta dos', active: false,
  }, 'PUT');
  assert.equal(forbiddenDisableWarehouse.status, 422);
  const seller = await enrollDevice(sellerUser);
  assert.equal((await request('/api/admin/routes', undefined, 'GET', seller)).status, 403);
});

test('vendedor consulta y opera solo clientes de su ruta y el servidor rechaza cambios manuales de ruta', async () => {
  const { productId, date } = await fixture();
  const otherWarehouse = await request('/api/admin/warehouses', { code: 'TEST-003', name: 'Bodega ruta tres' });
  assert.equal(otherWarehouse.status, 201);
  assert.equal((await request('/api/admin/routes', {
    id: 'route-003', name: 'Ruta 003', warehouseId: otherWarehouse.body.id, active: true,
  })).status, 201);
  const user = await createAccount('route-scope-seller');
  const assigned = await request(`/api/admin/users/${user.id}`, { routeId: 'route-003' }, 'PATCH');
  assert.equal(assigned.status, 200);
  const seller = await enrollDevice(user);
  const sessionInfo = await request('/api/auth/me', undefined, 'GET', seller);
  assert.equal(sessionInfo.body.user.routeId, 'route-003');
  assert.equal(sessionInfo.body.user.warehouseName, 'Bodega ruta tres');
  const outsideClient = await request('/api/sync', { operations: [{
    id: 'outside-route-client', kind: 'client', payload: { name: 'Cliente fuera', routeId: 'route-001' },
  }] }, 'POST', admin);
  assert.equal(outsideClient.body.results[0].ok, true);
  const visible = await request('/api/clients', undefined, 'GET', seller);
  assert.equal(visible.status, 200);
  assert.equal(visible.body.some((client) => client.id === 'outside-route-client'), false);
  const crossRoute = await request('/api/sync', { operations: [{
    id: 'cross-route-sale', kind: 'sale',
    payload: { clientId: 'outside-route-client', kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 1 }] },
  }] }, 'POST', seller);
  assert.equal(crossRoute.body.results[0].ok, false);
  assert.match(crossRoute.body.results[0].error, /ruta asignada/);
  const attemptedClient = await request('/api/sync', { operations: [{
    id: 'attempted-cross-route-client', kind: 'client',
    payload: { name: 'Cliente manipulado', routeId: 'route-001' },
  }] }, 'POST', seller);
  assert.equal(attemptedClient.body.results[0].ok, false);
  const ownClient = await request('/api/sync', { operations: [{
    id: 'route-three-client', kind: 'client', payload: { name: 'Cliente propio', routeId: 'route-003' },
  }] }, 'POST', seller);
  assert.equal(ownClient.body.results[0].ok, true);
  const routeWarehouse = db.prepare("SELECT warehouse_id FROM routes WHERE id = 'route-003'").get().warehouse_id;
  const routeStock = await request('/api/sync', { operations: [{
    id: 'route-three-opening-stock', kind: 'movement',
    payload: { productId, kind: 'ENTRY', quantity: 2, warehouseId: routeWarehouse, operatingDate: date },
  }] });
  assert.equal(routeStock.body.results[0].ok, true);
  const ownSale = await request('/api/sync', { operations: [{
    id: 'route-three-sale', kind: 'sale',
    payload: { clientId: 'route-three-client', kind: 'AUTOVENTA', operatingDate: date, lines: [{ productId, quantity: 1 }] },
  }] }, 'POST', seller);
  assert.equal(ownSale.body.results[0].ok, true);
  assert.equal((await request('/api/my/sales', undefined, 'GET', seller)).body.length, 1);
});

test('la migración de rutas y bodegas es aditiva para instalaciones existentes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dresa-routes-'));
  const path = join(directory, 'legacy-routes.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE routes (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO routes (id, name, active) VALUES ('route-001', 'Ruta 001', 1);
    CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO roles VALUES ('VENDEDOR', 'Vendedor');
    CREATE TABLE users (id TEXT PRIMARY KEY, full_name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    INSERT INTO users VALUES ('old-seller', 'Vendedor anterior', 'old-seller', 'hash', 'VENDEDOR', 1, '2025-01-01');`);
  legacy.close();
  let migrated;
  try {
    migrated = createDatabase(path);
    assert.equal(migrated.prepare('SELECT id, name FROM routes WHERE id = ?').get('route-001').name, 'Ruta 001');
    assert.equal(migrated.prepare('SELECT route_id FROM users WHERE id = ?').get('old-seller').route_id, null);
    assert.ok(migrated.prepare('PRAGMA table_info(routes)').all().some((column) => column.name === 'warehouse_id'));
    assert.ok(migrated.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'route_id'));
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM warehouses').get().count, 0);
  } finally {
    migrated?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
