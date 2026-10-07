import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const validTimestamp = (value) => {
  if (value == null || value === '') return now();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('La hora de la operación no es válida');
  return new Date(timestamp).toISOString();
};
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, required = false) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new Error(`${name} es obligatorio`);
  return result;
};
const positive = (value, name) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} debe ser mayor que cero`);
  return result;
};
const validDate = (value) => {
  const date = text(value, 'La fecha', true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('La fecha debe tener formato AAAA-MM-DD');
  }
  return date;
};
const validOperatingDate = (value) => {
  const date = validDate(value || today());
  if (date > today()) throw new Error('No se aceptan operaciones con fecha futura');
  return date;
};
const isClosed = (db, date) => Boolean(db.prepare('SELECT 1 FROM daily_closings WHERE closing_date = ?').get(date));
const stockOf = (db, productId, warehouseId = null) =>
  Number(db.prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS stock FROM inventory_movements
    WHERE product_id = ? AND (? IS NULL OR warehouse_id = ?)`)
    .get(productId, warehouseId, warehouseId).stock);

const warehouseForRoute = (db, routeId) => db.prepare(`SELECT w.id FROM routes r JOIN warehouses w ON w.id = r.warehouse_id
  WHERE r.id = ? AND r.active = 1 AND w.active = 1`).get(routeId)?.id || null;

const defaultWarehouse = (db) => {
  const rows = db.prepare('SELECT id FROM warehouses WHERE active = 1 ORDER BY created_at, id LIMIT 2').all();
  return rows.length === 1 ? rows[0].id : null;
};

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listWarehouses(db) {
  return db.prepare(`SELECT w.*, COUNT(r.id) AS route_count
    FROM warehouses w LEFT JOIN routes r ON r.warehouse_id = w.id
    GROUP BY w.id ORDER BY w.name`).all();
}

export function saveWarehouse(db, payload, id = randomUUID()) {
  const code = text(payload.code, 'El código de bodega', true);
  const name = text(payload.name, 'El nombre de bodega', true);
  if (code.length > 40 || name.length > 120) throw new Error('El código o nombre de bodega supera la longitud permitida');
  const active = payload.active == null ? 1 : payload.active === true || payload.active === 1 || payload.active === '1' ? 1
    : payload.active === false || payload.active === 0 || payload.active === '0' ? 0 : null;
  if (active === null) throw new Error('El estado de la bodega no es válido');
  const existing = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
  if (!existing) {
    const firstWarehouse = !db.prepare('SELECT 1 FROM warehouses LIMIT 1').get();
    try {
      db.prepare('INSERT INTO warehouses (id, code, name, active, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, code, name, active, now());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('El código de bodega ya existe');
      throw error;
    }
    if (firstWarehouse && active) {
      db.prepare('UPDATE inventory_movements SET warehouse_id = ? WHERE warehouse_id IS NULL').run(id);
    }
    return { id, created: true };
  }
  if (!active && Number(db.prepare('SELECT COUNT(*) AS count FROM routes WHERE warehouse_id = ? AND active = 1')
    .get(id).count)) throw new Error('No se puede desactivar una bodega asignada a una ruta activa');
  try {
    db.prepare('UPDATE warehouses SET code = ?, name = ?, active = ? WHERE id = ?')
      .run(code, name, active, id);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw new Error('El código de bodega ya existe');
    throw error;
  }
  return { id, updated: true };
}

export function listRoutes(db) {
  return db.prepare(`SELECT r.*, w.code AS warehouse_code, w.name AS warehouse_name, w.active AS warehouse_active,
      (SELECT COUNT(*) FROM users u WHERE u.route_id = r.id AND u.active = 1) AS active_users,
      (SELECT COUNT(*) FROM clients c WHERE c.route_id = r.id AND c.active = 1) AS active_clients
    FROM routes r LEFT JOIN warehouses w ON w.id = r.warehouse_id ORDER BY r.id`).all();
}

export function saveRoute(db, payload, id = randomUUID()) {
  const name = text(payload.name, 'El nombre de ruta', true);
  if (name.length > 120) throw new Error('El nombre de ruta supera el máximo de 120 caracteres');
  const warehouseId = payload.warehouseId == null || payload.warehouseId === '' ? null : text(payload.warehouseId, 'La bodega', true);
  const active = payload.active == null ? 1 : payload.active === true || payload.active === 1 || payload.active === '1' ? 1
    : payload.active === false || payload.active === 0 || payload.active === '0' ? 0 : null;
  if (active === null) throw new Error('El estado de la ruta no es válido');
  if (active && (!warehouseId || !db.prepare('SELECT id FROM warehouses WHERE id = ? AND active = 1').get(warehouseId))) {
    throw new Error('Una ruta activa debe estar asignada a una bodega activa');
  }
  const existing = db.prepare('SELECT id FROM routes WHERE id = ?').get(id);
  if (!existing) {
    db.prepare('INSERT INTO routes (id, name, active, warehouse_id) VALUES (?, ?, ?, ?)')
      .run(id, name, active, warehouseId);
    return { id, created: true };
  }
  if (!active && Number(db.prepare(`SELECT
      (SELECT COUNT(*) FROM users WHERE route_id = ? AND active = 1) +
      (SELECT COUNT(*) FROM clients WHERE route_id = ? AND active = 1) AS count`).get(id, id).count)) {
    throw new Error('No se puede desactivar una ruta con vendedores o clientes activos');
  }
  db.prepare('UPDATE routes SET name = ?, active = ?, warehouse_id = ? WHERE id = ?')
    .run(name, active, warehouseId, id);
  return { id, updated: true };
}

function assertActorRoute(db, actorUserId, routeId) {
  if (!actorUserId) return;
  const user = db.prepare('SELECT role_id, route_id FROM users WHERE id = ? AND active = 1').get(actorUserId);
  if (!user) throw new Error('El usuario responsable no está activo');
  if (user.role_id === 'ADMIN') return;
  if (!user.route_id || user.route_id !== routeId) throw new Error('La operación está fuera de la ruta asignada al vendedor');
  const route = db.prepare(`SELECT 1 FROM routes r JOIN warehouses w ON w.id = r.warehouse_id
    WHERE r.id = ? AND r.active = 1 AND w.active = 1`).get(routeId);
  if (!route) throw new Error('La ruta o su bodega no está activa');
}

function checkId(id) {
  const value = text(id, 'El identificador', true);
  if (value.length > 100) throw new Error('El identificador es demasiado largo');
  return value;
}

function createClient(db, payload, id, actorUserId) {
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (existing) {
    assertActorRoute(db, actorUserId, existing.route_id);
    return { entity: 'client', id, duplicate: true };
  }
  const fullName = text(payload.fullName, 'El nombre completo');
  const businessName = text(payload.businessName ?? payload.name, 'El nombre del negocio');
  const name = businessName || fullName;
  if (!name) throw new Error('El nombre completo o el nombre del negocio es obligatorio');
  if (fullName.length > 160 || businessName.length > 160) throw new Error('El nombre del cliente supera el máximo de 160 caracteres');
  const taxId = text(payload.taxId, 'El RUC / cédula');
  const email = text(payload.email, 'El correo electrónico');
  const notes = text(payload.notes, 'Las observaciones');
  const phone = text(payload.phone, 'El teléfono');
  const address = text(payload.address, 'La dirección');
  const reference = text(payload.reference, 'La referencia');
  if (taxId.length > 40 || phone.length > 60 || email.length > 254 || address.length > 400 ||
      reference.length > 400 || notes.length > 2000) {
    throw new Error('Uno o más datos del cliente superan la longitud permitida');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('El correo electrónico no es válido');
  const routeId = text(payload.routeId, 'La ruta') || 'route-001';
  if (!db.prepare('SELECT id FROM routes WHERE id = ? AND active = 1').get(routeId)) throw new Error('La ruta no existe o está inactiva');
  assertActorRoute(db, actorUserId, routeId);
  const latitude = payload.latitude === '' || payload.latitude == null ? null : Number(payload.latitude);
  const longitude = payload.longitude === '' || payload.longitude == null ? null : Number(payload.longitude);
  const active = payload.active === false || payload.active === 0 || payload.active === '0' ? 0 : 1;
  if ((latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
      (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
    throw new Error('La ubicación GPS no es válida');
  }
  db.prepare(`INSERT INTO clients
    (id, name, tax_id, full_name, business_name, phone, address, reference, email, notes,
      latitude, longitude, route_id, active, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, name, taxId, fullName, businessName, phone, address, reference, email, notes,
    latitude, longitude, routeId, active, actorUserId || null, now(),
  );
  return { entity: 'client', id };
}

export function updateClient(db, id, payload, actorUserId = null) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) throw new Error('El cliente no existe');
  const fullName = payload.fullName == null ? client.full_name : text(payload.fullName, 'El nombre completo');
  const businessName = payload.businessName == null ? client.business_name : text(payload.businessName, 'El nombre del negocio');
  const name = businessName || fullName || client.name;
  if (!name) throw new Error('El nombre completo o el nombre del negocio es obligatorio');
  const taxId = payload.taxId == null ? client.tax_id : text(payload.taxId, 'El RUC / cédula');
  const phone = payload.phone == null ? client.phone : text(payload.phone, 'El teléfono');
  const address = payload.address == null ? client.address : text(payload.address, 'La dirección');
  const reference = payload.reference == null ? client.reference : text(payload.reference, 'La referencia');
  const email = payload.email == null ? client.email : text(payload.email, 'El correo electrónico');
  const notes = payload.notes == null ? client.notes : text(payload.notes, 'Las observaciones');
  if (fullName.length > 160 || businessName.length > 160 || taxId.length > 40 || phone.length > 60 ||
      email.length > 254 || address.length > 400 || reference.length > 400 || notes.length > 2000) {
    throw new Error('Uno o más datos del cliente superan la longitud permitida');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('El correo electrónico no es válido');
  const routeId = payload.routeId == null ? client.route_id : text(payload.routeId, 'La ruta', true);
  if (!db.prepare('SELECT id FROM routes WHERE id = ? AND active = 1').get(routeId)) {
    throw new Error('La ruta no existe o está inactiva');
  }
  const latitude = payload.latitude == null
    ? client.latitude
    : payload.latitude === '' ? null : Number(payload.latitude);
  const longitude = payload.longitude == null
    ? client.longitude
    : payload.longitude === '' ? null : Number(payload.longitude);
  if ((latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
      (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
    throw new Error('La ubicación GPS no es válida');
  }
  const active = payload.active == null ? client.active
    : payload.active === true || payload.active === 1 || payload.active === '1' ? 1
      : payload.active === false || payload.active === 0 || payload.active === '0' ? 0 : null;
  if (active === null) throw new Error('El estado del cliente no es válido');
  const result = db.prepare(`UPDATE clients SET name = ?, tax_id = ?, full_name = ?, business_name = ?, phone = ?,
      address = ?, reference = ?, email = ?, notes = ?, latitude = ?, longitude = ?, route_id = ?, active = ?,
      updated_by = ?, updated_at = ? WHERE id = ?`)
    .run(name, taxId, fullName, businessName, phone, address, reference, email, notes, latitude,
      longitude, routeId, active, actorUserId || null, now(), id);
  if (!result.changes) throw new Error('El cliente no existe');
  return { id, updated: true };
}

function createProduct(db, payload, actorUserId) {
  const id = checkId(payload.id || randomUUID());
  if (db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return { id, duplicate: true };
  const code = text(payload.code, 'El código', true);
  if (code.length > 60) throw new Error('El código supera el máximo de 60 caracteres');
  const shortName = text(payload.shortName ?? payload.name, 'El nombre corto', true);
  if (shortName.length > 160) throw new Error('El nombre corto supera el máximo de 160 caracteres');
  const description = text(payload.description ?? payload.name, 'La descripción', true);
  if (description.length > 1000) throw new Error('La descripción supera el máximo de 1000 caracteres');
  const brand = text(payload.brand, 'La marca');
  const category = text(payload.category, 'La categoría');
  const family = text(payload.family, 'La familia');
  const weight = text(payload.weight, 'El gramaje / presentación');
  const unit = text(payload.unit, 'La unidad de inventario', true);
  if (brand.length > 100 || category.length > 100 || family.length > 100 || weight.length > 60 || unit.length > 40) {
    throw new Error('Uno o más datos del producto superan la longitud permitida');
  }
  if ((typeof payload.price !== 'number' && typeof payload.price !== 'string') ||
      (typeof payload.price === 'string' && !payload.price.trim())) {
    throw new Error('El precio sin IVA es obligatorio y debe ser numérico');
  }
  const price = Number(payload.price);
  if (!Number.isFinite(price) || price < 0) throw new Error('El precio debe ser cero o mayor');
  if (payload.stock != null && (typeof payload.stock === 'boolean' ||
      (typeof payload.stock !== 'number' && typeof payload.stock !== 'string'))) {
    throw new Error('El inventario inicial debe ser numérico');
  }
  const initialStock = Number(payload.stock ?? 0);
  if (!Number.isFinite(initialStock) || initialStock < 0) throw new Error('El inventario inicial no puede ser negativo');
  const active = parseProductActive(payload.active, 1);
  const date = validOperatingDate(payload.operatingDate);
  const timestamp = now();
  if (db.prepare('SELECT 1 FROM products WHERE code = ? COLLATE NOCASE').get(code)) {
    throw productCodeConflict();
  }
  try {
    return transaction(db, () => {
      if (isClosed(db, date)) throw new Error('El día indicado ya está cerrado');
      db.prepare(`INSERT INTO products
        (id, code, name, description, short_name, brand, category, family, weight, unit, price, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, code, shortName, description, shortName, brand, category, family, weight, unit, price, active, timestamp,
      );
      db.prepare(`INSERT INTO product_price_history (id, product_id, price, effective_at, updated_by)
        VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), id, price, timestamp, actorUserId || null);
      if (initialStock > 0) {
        const initialWarehouseId = payload.initialWarehouseId || defaultWarehouse(db);
        if (initialWarehouseId && !db.prepare('SELECT id FROM warehouses WHERE id = ? AND active = 1').get(initialWarehouseId)) {
          throw new Error('La bodega del inventario inicial no existe o está inactiva');
        }
        if (!initialWarehouseId && Number(db.prepare('SELECT COUNT(*) AS count FROM warehouses WHERE active = 1').get().count) > 1) {
          throw new Error('Selecciona una bodega para asignar el inventario inicial');
        }
        db.prepare(`INSERT INTO inventory_movements
          (id, product_id, warehouse_id, kind, quantity_delta, note, operating_date, created_by, created_at)
          VALUES (?, ?, ?, 'OPENING', ?, 'Inventario inicial', ?, ?, ?)`)
          .run(randomUUID(), id, initialWarehouseId, initialStock, date, actorUserId || null, timestamp);
      }
      return { id };
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed: products.code')) throw productCodeConflict();
    throw error;
  }
}

function productCodeConflict() {
  const error = new Error('Ya existe un producto con ese código');
  error.status = 409;
  return error;
}

function parseProductActive(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  throw new Error('El estado del producto no es válido');
}

function createSale(db, payload, id, actorUserId) {
  const clientId = text(payload.clientId, 'El cliente', true);
  const client = db.prepare('SELECT route_id, active FROM clients WHERE id = ?').get(clientId);
  if (client) assertActorRoute(db, actorUserId, client.route_id);
  const warehouseId = client ? warehouseForRoute(db, client.route_id) : null;
  const kind = text(payload.kind, 'El tipo', true).toUpperCase();
  if (!['AUTOVENTA', 'PREVENTA'].includes(kind)) throw new Error('El tipo debe ser AUTOVENTA o PREVENTA');
  const lines = payload.lines;
  if (!Array.isArray(lines) || lines.length < 1) throw new Error('Agrega al menos un producto');
  const operatingDate = validOperatingDate(payload.operatingDate);
  const hasOccurredAt = payload.occurredAt != null && payload.occurredAt !== '';
  const occurredAt = validTimestamp(payload.occurredAt);
  if (hasOccurredAt) {
    const operationTime = new Date(occurredAt);
    const occurredDate = `${operationTime.getFullYear()}-${String(operationTime.getMonth() + 1).padStart(2, '0')}-${String(operationTime.getDate()).padStart(2, '0')}`;
    if (occurredDate !== operatingDate) {
      throw new Error('La fecha y hora de la operación no coinciden');
    }
  }
  const reference = text(payload.reference ?? payload.notes, 'La referencia / observación');
  if (reference.length > 1000) throw new Error('La referencia / observación supera el máximo de 1000 caracteres');
  const parsed = lines.map((line) => {
    if (!asObject(line)) throw new Error('La línea de producto no es válida');
    const productId = text(line.productId, 'El producto', true);
    if (typeof line.quantity === 'boolean' ||
        (typeof line.quantity !== 'number' && typeof line.quantity !== 'string') ||
        (typeof line.quantity === 'string' && !line.quantity.trim())) {
      throw new Error('La cantidad debe ser numérica');
    }
    const quantity = positive(line.quantity, 'La cantidad');
    if (line.unitPrice != null && (typeof line.unitPrice === 'boolean' ||
        (typeof line.unitPrice !== 'number' && typeof line.unitPrice !== 'string') ||
        (typeof line.unitPrice === 'string' && !line.unitPrice.trim()))) {
      throw new Error('El precio de la línea debe ser numérico');
    }
    const unitPrice = line.unitPrice == null ? null : Number(line.unitPrice);
    if (unitPrice != null && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      throw new Error(`El precio de ${productId} no es válido`);
    }
    if (line.priceVersion != null && typeof line.priceVersion !== 'string') {
      throw new Error('La versión del precio no es válida');
    }
    const priceVersion = text(line.priceVersion, 'La versión del precio');
    return { productId, quantity, unitPrice, priceVersion };
  });
  if (new Set(parsed.map((line) => line.productId)).size !== parsed.length) throw new Error('Cada producto debe aparecer una sola vez');
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    if (existing) {
      const existingLines = db.prepare('SELECT product_id, quantity, unit_price FROM sale_lines WHERE sale_id = ? ORDER BY product_id').all(id);
      const retryLines = [...parsed].sort((left, right) => left.productId.localeCompare(right.productId));
      const matches = existing.client_id === clientId && existing.kind === kind &&
        existing.operating_date === operatingDate && (!hasOccurredAt || existing.occurred_at === occurredAt) &&
        (existing.reference || '') === reference &&
        (existing.created_by == null || existing.created_by === (actorUserId || null)) &&
        existingLines.length === retryLines.length &&
        existingLines.every((line, index) => line.product_id === retryLines[index].productId &&
          Number(line.quantity) === retryLines[index].quantity &&
          (retryLines[index].unitPrice == null || Number(line.unit_price) === retryLines[index].unitPrice));
      if (!matches) throw new Error('El identificador de venta ya fue utilizado para otra operación');
      return { entity: 'sale', id, duplicate: true, status: existing.status };
    }
    if (!client || !client.active) {
      throw new Error('El cliente no existe o está inactivo');
    }
    for (const line of parsed) {
      const product = db.prepare('SELECT id, price, active FROM products WHERE id = ?').get(line.productId);
      if (!product || !product.active) throw new Error(`El producto ${line.productId} no existe o está inactivo`);
      const quote = line.priceVersion
        ? db.prepare(`SELECT id, price, effective_at FROM product_price_history
            WHERE id = ? AND product_id = ?`).get(line.priceVersion, line.productId)
        : db.prepare(`SELECT id, price, effective_at FROM product_price_history
            WHERE product_id = ? ORDER BY effective_at DESC, rowid DESC LIMIT 1`).get(line.productId);
      if (!quote) throw new Error(`La cotización de precio de ${line.productId} no es válida`);
      if (line.priceVersion && Date.parse(occurredAt) < Date.parse(quote.effective_at)) {
        throw new Error(`La hora de la operación precede al precio cotizado para ${line.productId}`);
      }
      const nextQuote = db.prepare(`SELECT effective_at FROM product_price_history
        WHERE product_id = ? AND effective_at > ? ORDER BY effective_at ASC, rowid ASC LIMIT 1`)
        .get(line.productId, quote.effective_at);
      if (line.priceVersion && nextQuote && Date.parse(occurredAt) >= Date.parse(nextQuote.effective_at)) {
        throw new Error(`La cotización de precio de ${line.productId} ya no estaba vigente`);
      }
      const expectedPrice = Number(quote.price);
      if (line.unitPrice == null) line.unitPrice = Number(expectedPrice);
      if (Math.abs(line.unitPrice - expectedPrice) > 1e-9) {
        throw new Error(`El precio de ${line.productId} cambió; actualiza el catálogo antes de registrar la venta`);
      }
    }
    if (isClosed(db, operatingDate)) throw new Error('No se aceptan operaciones para un día ya cerrado');
    if (kind === 'AUTOVENTA') {
      for (const line of parsed) {
        const available = warehouseId ? stockOf(db, line.productId, warehouseId) : stockOf(db, line.productId);
        if (available < line.quantity) throw new Error(`Inventario insuficiente para ${line.productId}: disponible ${available}`);
      }
    }
    const status = kind === 'AUTOVENTA' ? 'COMPLETED' : 'PENDING';
    db.prepare(`INSERT INTO sales
      (id, client_id, kind, status, operating_date, occurred_at, reference, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, clientId, kind, status, operatingDate, occurredAt,
      reference, actorUserId || null, now());
    const insertLine = db.prepare('INSERT INTO sale_lines (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');
    const insertMovement = db.prepare(`INSERT INTO inventory_movements
      (id, product_id, warehouse_id, kind, quantity_delta, note, sale_id, operating_date, created_by, created_at)
      VALUES (?, ?, ?, 'SALE', ?, ?, ?, ?, ?, ?)`);
    for (const line of parsed) {
      insertLine.run(id, line.productId, line.quantity, line.unitPrice);
      if (kind === 'AUTOVENTA') {
        insertMovement.run(randomUUID(), line.productId, warehouseId, -line.quantity, `Autoventa ${id}`, id, operatingDate, actorUserId || null, now());
      }
    }
    return { entity: 'sale', id, status };
  });
}

function createMovement(db, payload, id, actorUserId) {
  const productId = text(payload.productId, 'El producto', true);
  const kind = text(payload.kind, 'El tipo', true).toUpperCase();
  if (!['ENTRY', 'EXIT', 'ADJUSTMENT', 'RETURN'].includes(kind)) throw new Error('Tipo de movimiento no válido');
  if (typeof payload.quantity === 'boolean' ||
      (typeof payload.quantity !== 'number' && typeof payload.quantity !== 'string') ||
      (typeof payload.quantity === 'string' && !payload.quantity.trim())) {
    throw new Error('La cantidad debe ser numérica');
  }
  const quantity = Number(payload.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) throw new Error('La cantidad no puede ser cero');
  if (kind !== 'ADJUSTMENT' && quantity < 0) throw new Error('La cantidad debe ser positiva');
  const delta = kind === 'EXIT' ? -quantity : quantity;
  const operatingDate = validOperatingDate(payload.operatingDate);
  const note = text(payload.reference ?? payload.note, 'La referencia / motivo');
  const actor = actorUserId ? db.prepare('SELECT route_id, role_id FROM users WHERE id = ?').get(actorUserId) : null;
  const warehouseId = payload.warehouseId || (actor?.role_id !== 'ADMIN' && actor?.route_id
    ? warehouseForRoute(db, actor.route_id) : defaultWarehouse(db));
  if (!warehouseId && Number(db.prepare('SELECT COUNT(*) AS count FROM warehouses WHERE active = 1').get().count) > 1) {
    throw new Error('Selecciona una bodega para registrar el movimiento');
  }
  if (payload.warehouseId && !db.prepare('SELECT id FROM warehouses WHERE id = ? AND active = 1').get(payload.warehouseId)) {
    throw new Error('La bodega no existe o está inactiva');
  }
  if (note.length > 240) throw new Error('La referencia / motivo supera el máximo de 240 caracteres');
  return transaction(db, () => {
    const existing = db.prepare(`SELECT product_id, warehouse_id, kind, quantity_delta, note, operating_date
      FROM inventory_movements WHERE id = ?`).get(id);
    if (existing) {
      if (existing.product_id === productId && existing.kind === kind &&
          Number(existing.quantity_delta) === delta && existing.note === note &&
          existing.operating_date === operatingDate &&
          (existing.warehouse_id || null) === (warehouseId || null)) {
        return { entity: 'movement', id, duplicate: true };
      }
      throw new Error('El identificador de movimiento ya fue utilizado para otra operación');
    }
    if (!db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(productId)) {
      throw new Error('El producto no existe o está inactivo');
    }
    if (isClosed(db, operatingDate)) throw new Error('No se aceptan movimientos para un día ya cerrado');
    if (delta < 0 && stockOf(db, productId, warehouseId) < -delta) throw new Error('Inventario insuficiente para registrar el movimiento');
    db.prepare(`INSERT INTO inventory_movements
      (id, product_id, warehouse_id, kind, quantity_delta, note, operating_date, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, productId, warehouseId, kind, delta, note, operatingDate, actorUserId || null, now(),
    );
    return { entity: 'movement', id };
  });
}

export function processOperation(db, operation, actorUserId = null) {
  if (!asObject(operation)) throw new Error('La operación no es válida');
  const id = checkId(operation.id);
  if (!asObject(operation.payload)) throw new Error('El contenido de la operación no es válido');
  switch (text(operation.kind, 'El tipo de operación', true)) {
    case 'client': return createClient(db, operation.payload, id, actorUserId);
    case 'sale': return createSale(db, operation.payload, id, actorUserId);
    case 'movement': return createMovement(db, operation.payload, id, actorUserId);
    default: throw new Error('Tipo de operación desconocido');
  }
}

export function saveProduct(db, payload, actorUserId = null) {
  return createProduct(db, payload, actorUserId);
}

export function updateProduct(db, id, payload, actorUserId = null) {
  const timestamp = now();
  try {
    transaction(db, () => {
      const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!current) throw new Error('El producto no existe');
      const code = payload.code == null ? current.code : text(payload.code, 'El código', true);
      const shortName = payload.shortName == null && payload.name == null
        ? current.short_name || current.name
        : text(payload.shortName ?? payload.name, 'El nombre corto', true);
      const description = payload.description == null ? current.description || '' : text(payload.description, 'La descripción');
      const brand = payload.brand == null ? current.brand : text(payload.brand, 'La marca');
      const category = payload.category == null ? current.category : text(payload.category, 'La categoría');
      const family = payload.family == null ? current.family || '' : text(payload.family, 'La familia');
      const weight = payload.weight == null ? current.weight : text(payload.weight, 'El gramaje / presentación');
      const unit = payload.unit == null ? current.unit : text(payload.unit, 'La unidad de inventario', true);
      if (code.length > 60 || shortName.length > 160 || description.length > 1000 ||
          brand.length > 100 || category.length > 100 || family.length > 100 ||
          weight.length > 60 || unit.length > 40) {
        throw new Error('Uno o más datos del producto superan la longitud permitida');
      }
      if (Object.hasOwn(payload, 'price') &&
          ((typeof payload.price !== 'number' && typeof payload.price !== 'string') ||
           (typeof payload.price === 'string' && !payload.price.trim()))) {
        throw new Error('El precio sin IVA debe ser numérico');
      }
      const price = Object.hasOwn(payload, 'price') ? Number(payload.price) : Number(current.price);
      if (!Number.isFinite(price) || price < 0) throw new Error('El precio sin IVA debe ser cero o mayor');
      const active = Object.hasOwn(payload, 'active')
        ? parseProductActive(payload.active, current.active) : current.active;
      if (db.prepare('SELECT 1 FROM products WHERE code = ? COLLATE NOCASE AND id != ?').get(code, id)) {
        throw productCodeConflict();
      }
      db.prepare(`UPDATE products SET code = ?, name = ?, description = ?, short_name = ?, brand = ?,
        category = ?, family = ?, weight = ?, unit = ?, price = ?, active = ? WHERE id = ?`).run(
        code, shortName, description, shortName, brand, category, family, weight, unit, price, active, id,
      );
      if (Number(current.price) !== price) {
        db.prepare(`INSERT INTO product_price_history (id, product_id, price, effective_at, updated_by)
          VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), id, price, timestamp, actorUserId || null);
      }
    });
    return { id };
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed: products.code')) throw productCodeConflict();
    throw error;
  }
}

export function setProductStatus(db, id, active) {
  if (typeof active !== 'boolean') throw new Error('El estado del producto no es válido');
  const result = db.prepare('UPDATE products SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (!result.changes) throw new Error('El producto no existe');
  return { id, active };
}

export function setClientStatus(db, id, active, actorUserId = null) {
  const result = db.prepare('UPDATE clients SET active = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .run(active ? 1 : 0, actorUserId || null, now(), id);
  if (!result.changes) throw new Error('El cliente no existe');
  return { id, active: Boolean(active) };
}

export function dispatchSale(db, id, operatingDate = today(), actorUserId = null) {
  return transaction(db, () => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    if (!sale) throw new Error('La preventa no existe');
    if (sale.status === 'DISPATCHED') return { id, status: 'DISPATCHED', duplicate: true };
    if (sale.kind !== 'PREVENTA' || sale.status !== 'PENDING') throw new Error('Solo se pueden despachar preventas pendientes');
    const routeId = db.prepare('SELECT route_id FROM clients WHERE id = ?').get(sale.client_id)?.route_id;
    const warehouseId = warehouseForRoute(db, routeId);
    const date = validOperatingDate(operatingDate);
    if (isClosed(db, date)) throw new Error('El día indicado ya está cerrado');
    const lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ?').all(id);
    for (const line of lines) {
      const available = warehouseId ? stockOf(db, line.product_id, warehouseId) : stockOf(db, line.product_id);
      if (available < line.quantity) throw new Error(`Inventario insuficiente para ${line.product_id}: disponible ${available}`);
    }
    const movement = db.prepare(`INSERT INTO inventory_movements
      (id, product_id, warehouse_id, kind, quantity_delta, note, sale_id, operating_date, created_by, created_at)
      VALUES (?, ?, ?, 'SALE', ?, ?, ?, ?, ?, ?)`);
    for (const line of lines) movement.run(randomUUID(), line.product_id, warehouseId, -line.quantity,
      `Despacho de preventa ${id}`, id, date, actorUserId || null, now());
    db.prepare(`UPDATE sales SET status = 'DISPATCHED', dispatched_by = ?, dispatched_at = ? WHERE id = ?`)
      .run(actorUserId || null, now(), id);
    return { id, status: 'DISPATCHED' };
  });
}

export function updatePreorder(db, id, payload) {
  const clientId = text(payload.clientId, 'El cliente', true);
  const operatingDate = validOperatingDate(payload.operatingDate);
  const reference = text(payload.reference ?? '', 'La referencia / observación');
  if (reference.length > 1000) throw new Error('La referencia / observación supera el máximo de 1000 caracteres');
  const lines = payload.lines;
  if (!Array.isArray(lines) || lines.length < 1) throw new Error('Agrega al menos un producto');
  const parsed = lines.map((line) => {
    if (!asObject(line)) throw new Error('La línea de producto no es válida');
    const productId = text(line.productId, 'El producto', true);
    if (typeof line.quantity === 'boolean' ||
        (typeof line.quantity !== 'number' && typeof line.quantity !== 'string') ||
        (typeof line.quantity === 'string' && !line.quantity.trim())) {
      throw new Error('La cantidad debe ser numérica');
    }
    return { productId, quantity: positive(line.quantity, 'La cantidad') };
  });
  if (new Set(parsed.map((line) => line.productId)).size !== parsed.length) {
    throw new Error('Cada producto debe aparecer una sola vez');
  }

  return transaction(db, () => {
    const sale = db.prepare('SELECT kind, status FROM sales WHERE id = ?').get(id);
    if (!sale || sale.kind !== 'PREVENTA' || sale.status !== 'PENDING') {
      throw new Error('Solo se pueden modificar preventas pendientes');
    }
    const client = db.prepare('SELECT active FROM clients WHERE id = ?').get(clientId);
    if (!client || !client.active) throw new Error('El cliente no existe o está inactivo');
    if (isClosed(db, operatingDate)) throw new Error('No se aceptan operaciones para un día ya cerrado');

    const existingPrices = new Map(db.prepare('SELECT product_id, unit_price FROM sale_lines WHERE sale_id = ?')
      .all(id).map((line) => [line.product_id, Number(line.unit_price)]));
    for (const line of parsed) {
      const product = db.prepare('SELECT price, active FROM products WHERE id = ?').get(line.productId);
      if (!product || !product.active) throw new Error(`El producto ${line.productId} no existe o está inactivo`);
      line.unitPrice = existingPrices.get(line.productId) ?? Number(product.price);
    }

    db.prepare(`UPDATE sales SET client_id = ?, operating_date = ?, reference = ? WHERE id = ?`)
      .run(clientId, operatingDate, reference, id);
    db.prepare('DELETE FROM sale_lines WHERE sale_id = ?').run(id);
    const insertLine = db.prepare('INSERT INTO sale_lines (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');
    for (const line of parsed) insertLine.run(id, line.productId, line.quantity, line.unitPrice);
    return { id, status: 'PENDING', updated: true };
  });
}

export function cancelPreorder(db, id) {
  const result = db.prepare("UPDATE sales SET status = 'CANCELLED' WHERE id = ? AND kind = 'PREVENTA' AND status = 'PENDING'").run(id);
  if (!result.changes) throw new Error('Solo se pueden cancelar preventas pendientes');
  return { id, status: 'CANCELLED' };
}

export function closeDay(db, closingDate, actorUserId = null) {
  const date = validDate(closingDate);
  if (date > today()) throw new Error('No se puede cerrar una fecha futura');
  return transaction(db, () => {
    const existing = db.prepare('SELECT id FROM daily_closings WHERE closing_date = ?').get(date);
    if (existing) return { id: existing.id, closingDate: date, duplicate: true };
    const id = randomUUID();
    db.prepare('INSERT INTO daily_closings (id, closing_date, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(id, date, actorUserId || null, now());
    const products = db.prepare('SELECT id FROM products ORDER BY code').all();
    const insertLine = db.prepare(`INSERT INTO daily_closing_lines
      (closing_id, product_id, opening_stock, entries, exits, sales, adjustments, returns, closing_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const product of products) {
      const allBefore = Number(db.prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS qty FROM inventory_movements
        WHERE product_id = ? AND operating_date < ?`).get(product.id, date).qty);
      const amounts = db.prepare(`SELECT kind, SUM(ABS(quantity_delta)) AS quantity FROM inventory_movements
        WHERE product_id = ? AND operating_date = ? GROUP BY kind`).all(product.id, date);
      const totals = Object.fromEntries(amounts.map((row) => [row.kind, Number(row.quantity)]));
      const sales = totals.SALE || 0;
      const closing = Number(db.prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS qty FROM inventory_movements
        WHERE product_id = ? AND operating_date <= ?`).get(product.id, date).qty);
      insertLine.run(id, product.id, allBefore, (totals.ENTRY || 0) + (totals.OPENING || 0), totals.EXIT || 0, sales,
        db.prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS amount FROM inventory_movements
          WHERE product_id = ? AND operating_date = ? AND kind = 'ADJUSTMENT'`).get(product.id, date).amount,
        totals.RETURN || 0, closing);
    }
    return { id, closingDate: date };
  });
}

export function listProducts(db, includeInactive = true, search = '', warehouseId = null) {
  const term = text(search, 'La búsqueda');
  if (term.length > 120) throw new Error('La búsqueda no puede superar 120 caracteres');
  return db.prepare(`SELECT p.*,
      (SELECT h.id FROM product_price_history h WHERE h.product_id = p.id
        ORDER BY h.effective_at DESC, h.rowid DESC LIMIT 1) AS price_version,
      COALESCE(SUM(m.quantity_delta), 0) AS stock
    FROM products p LEFT JOIN inventory_movements m
      ON m.product_id = p.id AND (? IS NULL OR m.warehouse_id = ?)
    WHERE (? = 1 OR p.active = 1)
      AND (? = '' OR p.code LIKE ? OR p.name LIKE ? OR p.short_name LIKE ? OR p.description LIKE ?
        OR p.brand LIKE ? OR p.category LIKE ? OR p.family LIKE ? OR p.weight LIKE ?)
    GROUP BY p.id ORDER BY p.name`).all(
    warehouseId, warehouseId, includeInactive ? 1 : 0, term, ...Array(8).fill(`%${term}%`),
  );
}

export function listClients(db, includeInactive = false, routeId = null, search = '') {
  const term = text(search, 'La búsqueda');
  if (term.length > 120) throw new Error('La búsqueda no puede superar 120 caracteres');
  return db.prepare(`SELECT c.*, r.name AS route_name, creator.full_name AS actor_name,
      updater.full_name AS updated_by_name FROM clients c
    JOIN routes r ON r.id = c.route_id LEFT JOIN users creator ON creator.id = c.created_by
    LEFT JOIN users updater ON updater.id = c.updated_by
    WHERE (? = 1 OR c.active = 1) AND (? IS NULL OR c.route_id = ?)
      AND (? = '' OR c.name LIKE ? OR c.tax_id LIKE ? OR c.full_name LIKE ? OR c.business_name LIKE ?
        OR c.phone LIKE ? OR c.email LIKE ? OR c.address LIKE ? OR c.reference LIKE ? OR c.notes LIKE ?)
    ORDER BY c.name`)
    .all(includeInactive ? 1 : 0, routeId, routeId, term, ...Array(9).fill(`%${term}%`));
}

export function listMovements(db) {
  return db.prepare(`SELECT m.*, p.code AS product_code, p.name AS product_name, u.full_name AS actor_name,
      w.code AS warehouse_code, w.name AS warehouse_name
    FROM inventory_movements m JOIN products p ON p.id = m.product_id
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN warehouses w ON w.id = m.warehouse_id
    ORDER BY m.created_at DESC`).all();
}

export function listSales(db) {
  return db.prepare(`SELECT s.*, c.name AS client_name, seller.full_name AS seller_name,
      dispatcher.full_name AS dispatcher_name,
      (SELECT COALESCE(SUM(l.quantity * l.unit_price), 0) FROM sale_lines l WHERE l.sale_id = s.id) AS total,
      (SELECT json_group_array(json_object('productId', l.product_id, 'code', p.code, 'name', p.name, 'quantity', l.quantity, 'unitPrice', l.unit_price))
        FROM sale_lines l JOIN products p ON p.id = l.product_id WHERE l.sale_id = s.id) AS lines
    FROM sales s JOIN clients c ON c.id = s.client_id
    LEFT JOIN users seller ON seller.id = s.created_by
    LEFT JOIN users dispatcher ON dispatcher.id = s.dispatched_by
    ORDER BY s.created_at DESC`).all();
}

export function listSellerSales(db, userId) {
  return db.prepare(`SELECT s.*, c.name AS client_name,
      (SELECT COALESCE(SUM(l.quantity * l.unit_price), 0) FROM sale_lines l WHERE l.sale_id = s.id) AS total,
      (SELECT json_group_array(json_object('productId', l.product_id, 'code', p.code, 'name', p.name, 'quantity', l.quantity, 'unitPrice', l.unit_price))
        FROM sale_lines l JOIN products p ON p.id = l.product_id WHERE l.sale_id = s.id) AS lines
    FROM sales s JOIN clients c ON c.id = s.client_id
    WHERE s.created_by = ? ORDER BY s.created_at DESC`).all(userId);
}

export function listClosings(db) {
  return db.prepare(`SELECT c.*, u.full_name AS actor_name FROM daily_closings c
    LEFT JOIN users u ON u.id = c.created_by ORDER BY c.closing_date DESC`).all();
}

export function getClosingDetails(db, date) {
  return db.prepare(`SELECT p.code, p.name, p.unit, l.*
    FROM daily_closings c JOIN daily_closing_lines l ON l.closing_id = c.id
    JOIN products p ON p.id = l.product_id WHERE c.closing_date = ? ORDER BY p.code`).all(date);
}

export function getInventory(db, warehouseId = null) {
  return listProducts(db).map((product) => {
    const stock = warehouseId
      ? Number(db.prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS stock FROM inventory_movements
          WHERE product_id = ? AND warehouse_id = ?`).get(product.id, warehouseId).stock)
      : Number(product.stock);
    const totals = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind IN ('OPENING', 'ENTRY') THEN quantity_delta ELSE 0 END), 0) AS entries,
      COALESCE(SUM(CASE WHEN kind = 'EXIT' THEN -quantity_delta ELSE 0 END), 0) AS exits,
      COALESCE(SUM(CASE WHEN kind = 'SALE' THEN -quantity_delta ELSE 0 END), 0) AS sales,
      COALESCE(SUM(CASE WHEN kind = 'ADJUSTMENT' THEN quantity_delta ELSE 0 END), 0) AS adjustments,
      COALESCE(SUM(CASE WHEN kind = 'RETURN' THEN quantity_delta ELSE 0 END), 0) AS returns
      FROM inventory_movements WHERE product_id = ? AND (? IS NULL OR warehouse_id = ?)`)
      .get(product.id, warehouseId, warehouseId);
    return { ...product, stock, ...totals, warehouse_id: warehouseId };
  });
}

export function getUnassignedInventory(db) {
  return db.prepare(`SELECT p.id, p.code, p.name, p.unit,
      COALESCE(SUM(m.quantity_delta), 0) AS stock
    FROM products p LEFT JOIN inventory_movements m
      ON m.product_id = p.id AND m.warehouse_id IS NULL
    GROUP BY p.id ORDER BY p.code`).all();
}

export function listSalesReport(db, filters = {}) {
  const from = filters.from ? validDate(filters.from) : '';
  const to = filters.to ? validDate(filters.to) : '';
  if (from && to && from > to) throw new Error('La fecha inicial no puede ser posterior a la fecha final');
  const sellerId = text(filters.sellerId, 'El vendedor');
  const routeId = text(filters.routeId, 'La ruta');
  const clientId = text(filters.clientId, 'El cliente');
  const productId = text(filters.productId, 'El producto');
  return db.prepare(`SELECT s.*, c.name AS client_name, c.route_id, r.name AS route_name,
      seller.full_name AS seller_name, dispatcher.full_name AS dispatcher_name,
      (SELECT COALESCE(SUM(l.quantity * l.unit_price), 0) FROM sale_lines l WHERE l.sale_id = s.id) AS total,
      (SELECT json_group_array(json_object('productId', l.product_id, 'code', p.code, 'name', p.name,
        'quantity', l.quantity, 'unitPrice', l.unit_price))
        FROM sale_lines l JOIN products p ON p.id = l.product_id WHERE l.sale_id = s.id) AS lines
    FROM sales s JOIN clients c ON c.id = s.client_id JOIN routes r ON r.id = c.route_id
    LEFT JOIN users seller ON seller.id = s.created_by
    LEFT JOIN users dispatcher ON dispatcher.id = s.dispatched_by
    WHERE (? = '' OR s.operating_date >= ?) AND (? = '' OR s.operating_date <= ?)
      AND (? = '' OR s.created_by = ?) AND (? = '' OR c.route_id = ?)
      AND (? = '' OR c.id = ?)
      AND (? = '' OR EXISTS (SELECT 1 FROM sale_lines filter_line
        WHERE filter_line.sale_id = s.id AND filter_line.product_id = ?))
    ORDER BY s.operating_date DESC, s.occurred_at DESC`)
    .all(from, from, to, to, sellerId, sellerId, routeId, routeId, clientId, clientId, productId, productId);
}

export function getRotation(db, from, to) {
  const start = validDate(from);
  const end = validDate(to);
  if (start > end) throw new Error('La fecha inicial no puede ser posterior a la fecha final');
  return db.prepare(`SELECT p.id, p.code, p.name, p.category, p.unit, p.active,
      COALESCE(stock.quantity, 0) AS stock,
      COALESCE(period.sold, 0) AS sold,
      COALESCE(period.movement_count, 0) AS movement_count,
      period.last_sale
    FROM products p
    LEFT JOIN (SELECT product_id, SUM(quantity_delta) AS quantity FROM inventory_movements GROUP BY product_id) stock
      ON stock.product_id = p.id
    LEFT JOIN (
      SELECT m.product_id,
        SUM(CASE WHEN m.kind = 'SALE' THEN -m.quantity_delta ELSE 0 END) AS sold,
        COUNT(*) AS movement_count,
        MAX(CASE WHEN m.kind = 'SALE' THEN m.operating_date END) AS last_sale
      FROM inventory_movements m
      WHERE m.operating_date BETWEEN ? AND ?
      GROUP BY m.product_id
    ) period ON period.product_id = p.id
    ORDER BY sold DESC, p.code`).all(start, end);
}

export function getClosingLines(db, date) {
  return getClosingDetails(db, date);
}

export function dateToday() {
  return today();
}
