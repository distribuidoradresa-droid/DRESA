import { DatabaseSync } from 'node:sqlite';

export function createDatabase(path = process.env.DRESA_DB_PATH || 'data/dresa.sqlite') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      warehouse_id TEXT REFERENCES warehouses(id)
    );
    INSERT OR IGNORE INTO routes (id, name) VALUES ('route-001', 'Ruta 001');

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT OR IGNORE INTO roles (id, name) VALUES
      ('ADMIN', 'Administrador / Matriz'),
      ('VENDEDOR', 'Vendedor'),
      ('PREVENTA', 'Preventa');
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES roles(id),
      route_id TEXT REFERENCES routes(id),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'BLOCKED', 'REVOKED')),
      created_at TEXT NOT NULL,
      last_seen TEXT,
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices (status, created_at);
    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id),
      subject_user_id TEXT REFERENCES users(id),
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events (created_at DESC);

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      short_name TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      family TEXT NOT NULL DEFAULT '',
      weight TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'unidad',
      price REAL NOT NULL CHECK (price >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tax_id TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL DEFAULT '',
      business_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      latitude REAL,
      longitude REAL,
      route_id TEXT NOT NULL DEFAULT 'route-001' REFERENCES routes(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id),
      updated_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      kind TEXT NOT NULL CHECK (kind IN ('AUTOVENTA', 'PREVENTA')),
      status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'PENDING', 'DISPATCHED', 'CANCELLED')),
      operating_date TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id),
      dispatched_by TEXT REFERENCES users(id),
      dispatched_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sale_lines (
      sale_id TEXT NOT NULL REFERENCES sales(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity REAL NOT NULL CHECK (quantity > 0),
      unit_price REAL NOT NULL CHECK (unit_price >= 0),
      PRIMARY KEY (sale_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      warehouse_id TEXT REFERENCES warehouses(id),
      kind TEXT NOT NULL CHECK (kind IN ('OPENING', 'ENTRY', 'EXIT', 'SALE', 'ADJUSTMENT', 'RETURN')),
      quantity_delta REAL NOT NULL CHECK (quantity_delta != 0),
      note TEXT NOT NULL DEFAULT '',
      sale_id TEXT REFERENCES sales(id),
      operating_date TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_price_history (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      price REAL NOT NULL CHECK (price >= 0),
      effective_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id),
      UNIQUE (product_id, effective_at)
    );
    CREATE INDEX IF NOT EXISTS idx_product_price_history
      ON product_price_history (product_id, effective_at);
    CREATE TABLE IF NOT EXISTS daily_closings (
      id TEXT PRIMARY KEY,
      closing_date TEXT NOT NULL UNIQUE,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      user_id TEXT NOT NULL REFERENCES users(id),
      operation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      error TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL,
      PRIMARY KEY (user_id, operation_id)
    );
    CREATE TABLE IF NOT EXISTS daily_closing_lines (
      closing_id TEXT NOT NULL REFERENCES daily_closings(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      opening_stock REAL NOT NULL,
      entries REAL NOT NULL,
      exits REAL NOT NULL,
      sales REAL NOT NULL,
      adjustments REAL NOT NULL,
      returns REAL NOT NULL,
      closing_stock REAL NOT NULL,
      PRIMARY KEY (closing_id, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_movements_date ON inventory_movements (operating_date);
    CREATE INDEX IF NOT EXISTS idx_movements_product ON inventory_movements (product_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales (operating_date);
  `);
  db.exec(`CREATE TRIGGER IF NOT EXISTS inventory_movements_prevent_negative_stock
    BEFORE INSERT ON inventory_movements
    WHEN NEW.quantity_delta < 0
      AND COALESCE((SELECT SUM(quantity_delta) FROM inventory_movements WHERE product_id = NEW.product_id), 0)
        + NEW.quantity_delta < 0
    BEGIN
      SELECT RAISE(ABORT, 'Inventario insuficiente para registrar el movimiento');
    END`);
  const saleColumns = db.prepare('PRAGMA table_info(sales)').all();
  if (!saleColumns.some((column) => column.name === 'occurred_at')) {
    db.exec("ALTER TABLE sales ADD COLUMN occurred_at TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE sales SET occurred_at = created_at WHERE occurred_at = ''");
  }
  const additiveColumns = {
    routes: { warehouse_id: 'TEXT REFERENCES warehouses(id)' },
    users: { route_id: 'TEXT REFERENCES routes(id)' },
    products: {
      description: "TEXT NOT NULL DEFAULT ''",
      short_name: "TEXT NOT NULL DEFAULT ''",
      family: "TEXT NOT NULL DEFAULT ''",
    },
    clients: {
      tax_id: "TEXT NOT NULL DEFAULT ''",
      full_name: "TEXT NOT NULL DEFAULT ''",
      business_name: "TEXT NOT NULL DEFAULT ''",
      email: "TEXT NOT NULL DEFAULT ''",
      notes: "TEXT NOT NULL DEFAULT ''",
      created_by: 'TEXT REFERENCES users(id)',
      updated_by: 'TEXT REFERENCES users(id)',
      updated_at: 'TEXT',
    },
    sales: {
      reference: "TEXT NOT NULL DEFAULT ''",
      created_by: 'TEXT REFERENCES users(id)',
      dispatched_by: 'TEXT REFERENCES users(id)',
      dispatched_at: 'TEXT',
    },
    inventory_movements: {
      created_by: 'TEXT REFERENCES users(id)',
      warehouse_id: 'TEXT REFERENCES warehouses(id)',
    },
    daily_closings: { created_by: 'TEXT REFERENCES users(id)' },
  };
  for (const [table, columns] of Object.entries(additiveColumns)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_movements_warehouse_product ON inventory_movements (warehouse_id, product_id, operating_date)');
  db.exec(`UPDATE products SET short_name = name WHERE short_name = ''`);
  db.exec(`INSERT OR IGNORE INTO product_price_history (id, product_id, price, effective_at)
    SELECT lower(hex(randomblob(16))), id, price, created_at FROM products`);
  return db;
}
