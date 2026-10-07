import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './database.js';
import {
  approveDevice, authStatus, AuthError, clearedSessionCookie, clearLoginFailures,
  createBootstrapToken, createFirstAdmin, createUser, getSessionCookieName, listDevices,
  listSecurityEvents, listSessions, listUsers, login, readSession, recordLoginFailure,
  recordSecurityEvent, requestDeviceId, revokeSession, resetPassword, sessionCookie,
  setDeviceStatus, updateUser,
} from './auth.js';
import {
  cancelPreorder, closeDay, dateToday, dispatchSale, getClosingDetails, getInventory,
  getRotation, listClients, listClosings, listMovements, listProducts, listRoutes, listSales,
  getUnassignedInventory, listSalesReport, listSellerSales, listWarehouses, processOperation, saveProduct, saveRoute, saveWarehouse,
  setClientStatus, setProductStatus, updateClient, updateProduct, updatePreorder,
} from './domain.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicRoot = join(root, 'public');
const databasePath = process.env.DRESA_DB_PATH || join(root, 'data', 'dresa.sqlite');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
};

function getCookie(request, name) {
  const cookies = request.headers.cookie || '';
  for (const item of cookies.split(';')) {
    const separator = item.indexOf('=');
    if (separator !== -1 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return '';
}

function requireRole(session, roles) {
  if (!session) throw new AuthError(401, 'AUTH_REQUIRED', 'Inicia sesión para continuar');
  if (!roles.includes(session.role)) throw new AuthError(403, 'FORBIDDEN', 'Tu rol no tiene permiso para esta función');
}

function assertSessionDevice(request, session) {
  const supplied = request.headers['x-dresa-device'];
  if (typeof supplied !== 'string' || supplied !== session.deviceId) {
    throw new AuthError(403, 'DEVICE_MISMATCH', 'La sesión no pertenece a este dispositivo');
  }
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin && origin !== `http${request.socket.encrypted ? 's' : ''}://${request.headers.host}`) {
    throw new AuthError(403, 'INVALID_ORIGIN', 'Solicitud rechazada');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new AuthError(403, 'CROSS_SITE_REQUEST', 'Solicitud rechazada');
  }
}

function recordSyncConflict(database, userId, operation, error) {
  if (typeof operation?.id !== 'string' || !operation.id || operation.id.length > 100) return;
  const timestamp = new Date().toISOString();
  database.prepare(`INSERT INTO sync_conflicts
      (user_id, operation_id, operation_kind, payload_json, error, attempts, first_seen_at, last_attempt_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT (user_id, operation_id) DO UPDATE SET
      operation_kind = excluded.operation_kind,
      payload_json = excluded.payload_json,
      error = excluded.error,
      attempts = sync_conflicts.attempts + 1,
      last_attempt_at = excluded.last_attempt_at`)
    .run(userId, operation.id, String(operation.kind || 'desconocido').slice(0, 40),
      JSON.stringify(operation.payload ?? {}), String(error.message || error).slice(0, 1000), timestamp, timestamp);
}

function canUseRoute(session, method, path, body) {
  if (session.role === 'ADMIN') return true;
  if (method === 'GET' && ['/api/products', '/api/clients', '/api/my/sales'].includes(path)) return true;
  if (method === 'POST' && path === '/api/sync' && Array.isArray(body?.operations)) {
    return body.operations.every((operation) => {
      if (operation?.kind === 'client') return true;
      if (operation?.kind !== 'sale') return false;
      return session.role === 'VENDEDOR' ||
        (session.role === 'PREVENTA' && String(operation.payload?.kind).toUpperCase() === 'PREVENTA');
    });
  }
  return false;
}

export function createApp(database = createDatabase(), options = {}) {
  const bootstrapToken = options.bootstrapToken || createBootstrapToken();
  const loginLimits = new Map();
  return createHttpServer(async (request, response) => {
    const sendJson = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    const readJson = async () => {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 1_000_000) throw new Error('El cuerpo de la solicitud es demasiado grande');
      }
      return raw ? JSON.parse(raw) : {};
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assertSameOrigin(request);
      if (request.method === 'GET' && path === '/api/health') return sendJson(200, { ok: true, date: dateToday() });
      if (request.method === 'GET' && path === '/api/auth/status') return sendJson(200, authStatus(database));
      if (request.method === 'GET' && path === '/api/auth/me') {
        const session = readSession(database, getCookie(request, getSessionCookieName()));
        if (!session) throw new AuthError(401, 'AUTH_REQUIRED', 'Inicia sesión para continuar');
        assertSessionDevice(request, session);
        database.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(new Date().toISOString(), session.tokenHash);
        database.prepare('UPDATE devices SET last_seen = ? WHERE id = ? AND user_id = ?')
          .run(new Date().toISOString(), session.deviceId, session.userId);
        return sendJson(200, { user: {
          id: session.userId, name: session.fullName, username: session.username, role: session.role,
          routeId: session.routeId, routeName: session.routeName,
          warehouseId: session.warehouseId, warehouseName: session.warehouseName,
        }, deviceId: session.deviceId, expiresAt: session.expiresAt, csrfToken: session.csrfToken });
      }
      if (request.method === 'POST' && path === '/api/auth/bootstrap') {
        const body = await readJson();
        if (!authStatus(database).setupRequired) throw new AuthError(409, 'ALREADY_CONFIGURED', 'La configuración inicial ya fue completada');
        const id = requestDeviceId(request);
        if (body.deviceId !== id) throw new AuthError(403, 'DEVICE_MISMATCH', 'Identificador de dispositivo no válido');
        const result = await createFirstAdmin(database, body, bootstrapToken, id, request.headers['user-agent']);
        recordSecurityEvent(database, result.session.user.id, result.session.user.id, 'ADMIN_BOOTSTRAPPED');
        response.setHeader('Set-Cookie', sessionCookie(result.token));
        return sendJson(201, result.session);
      }
      if (request.method === 'POST' && path === '/api/auth/login') {
        const body = await readJson();
        const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
        const remote = request.socket.remoteAddress || 'local';
        const rateKey = `${remote}|${username}`;
        const blocked = loginLimits.get(rateKey);
        if (blocked?.blockedUntil > Date.now()) {
          throw new AuthError(429, 'LOGIN_RATE_LIMIT', 'Demasiados intentos; vuelve a intentar más tarde');
        }
        try {
          const id = requestDeviceId(request);
          if (body.deviceId !== id) throw new AuthError(403, 'DEVICE_MISMATCH', 'Identificador de dispositivo no válido');
          const result = await login(database, body, request.headers['user-agent']);
          recordSecurityEvent(database, result.session.user.id, result.session.user.id, 'LOGIN_SUCCEEDED', {
            deviceId: result.session.deviceId,
          });
          clearLoginFailures(loginLimits, rateKey);
          response.setHeader('Set-Cookie', sessionCookie(result.token));
          return sendJson(200, result.session);
        } catch (error) {
          if (error instanceof AuthError && error.status === 401) recordLoginFailure(loginLimits, rateKey);
          if (error instanceof AuthError && error.code === 'DEVICE_PENDING') {
            const pendingUser = database.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
            recordSecurityEvent(database, null, pendingUser?.id, 'DEVICE_AUTHORIZATION_REQUESTED', {
              deviceId: body.deviceId,
            });
          }
          throw error;
        }
      }
      if (request.method === 'POST' && path === '/api/auth/logout') {
        const token = getCookie(request, getSessionCookieName());
        const session = readSession(database, token);
        if (session) {
          assertSessionDevice(request, session);
          if (request.headers['x-dresa-csrf'] !== session.csrfToken) {
            throw new AuthError(403, 'INVALID_CSRF_TOKEN', 'La solicitud no pasó la validación de seguridad');
          }
          database.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?')
            .run(new Date().toISOString(), session.tokenHash);
          recordSecurityEvent(database, session.userId, session.userId, 'LOGOUT', {
            deviceId: session.deviceId,
          });
        }
        response.setHeader('Set-Cookie', clearedSessionCookie());
        return sendJson(200, { ok: true });
      }
      const session = readSession(database, getCookie(request, getSessionCookieName()));
      if (path.startsWith('/api/')) {
        if (!session) throw new AuthError(401, 'AUTH_REQUIRED', 'Inicia sesión para continuar');
        assertSessionDevice(request, session);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
            request.headers['x-dresa-csrf'] !== session.csrfToken) {
          throw new AuthError(403, 'INVALID_CSRF_TOKEN', 'La solicitud no pasó la validación de seguridad');
        }
        database.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(new Date().toISOString(), session.tokenHash);
        database.prepare('UPDATE devices SET last_seen = ? WHERE id = ? AND user_id = ?')
          .run(new Date().toISOString(), session.deviceId, session.userId);
      }
      if (request.method === 'GET' && path === '/api/admin/users') {
        requireRole(session, ['ADMIN']);
        return sendJson(200, listUsers(database));
      }
      if (request.method === 'GET' && path === '/api/admin/routes') {
        requireRole(session, ['ADMIN']);
        return sendJson(200, listRoutes(database));
      }
      if (request.method === 'POST' && path === '/api/admin/routes') {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;
        if (id && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('El identificador de ruta no es válido');
        if (id && database.prepare('SELECT 1 FROM routes WHERE id = ?').get(id)) throw new Error('El identificador de ruta ya existe');
        const result = saveRoute(database, body, id);
        recordSecurityEvent(database, session.userId, null, 'ROUTE_CREATED', {
          routeId: result.id, warehouseId: body.warehouseId || null,
          active: body.active == null || body.active === true || body.active === 1 || body.active === '1',
        });
        return sendJson(201, result);
      }
      const routeMatch = path.match(/^\/api\/admin\/routes\/([^/]+)$/);
      if (request.method === 'PUT' && routeMatch) {
        requireRole(session, ['ADMIN']);
        if (!database.prepare('SELECT 1 FROM routes WHERE id = ?').get(routeMatch[1])) {
          throw new AuthError(404, 'ROUTE_NOT_FOUND', 'La ruta no existe');
        }
        const body = await readJson();
        const result = saveRoute(database, body, routeMatch[1]);
        recordSecurityEvent(database, session.userId, null, 'ROUTE_UPDATED', {
          routeId: routeMatch[1], warehouseId: body.warehouseId || null,
          active: body.active == null || body.active === true || body.active === 1 || body.active === '1',
        });
        return sendJson(200, result);
      }
      if (request.method === 'GET' && path === '/api/admin/warehouses') {
        requireRole(session, ['ADMIN']);
        return sendJson(200, listWarehouses(database));
      }
      if (request.method === 'POST' && path === '/api/admin/warehouses') {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        const result = saveWarehouse(database, body);
        recordSecurityEvent(database, session.userId, null, 'WAREHOUSE_CREATED', {
          warehouseId: result.id,
          active: body.active == null || body.active === true || body.active === 1 || body.active === '1',
        });
        return sendJson(201, result);
      }
      const warehouseMatch = path.match(/^\/api\/admin\/warehouses\/([^/]+)$/);
      if (request.method === 'PUT' && warehouseMatch) {
        requireRole(session, ['ADMIN']);
        if (!database.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(warehouseMatch[1])) {
          throw new AuthError(404, 'WAREHOUSE_NOT_FOUND', 'La bodega no existe');
        }
        const body = await readJson();
        const result = saveWarehouse(database, body, warehouseMatch[1]);
        recordSecurityEvent(database, session.userId, null, 'WAREHOUSE_UPDATED', {
          warehouseId: warehouseMatch[1],
          active: body.active == null || body.active === true || body.active === 1 || body.active === '1',
        });
        return sendJson(200, result);
      }
      if (request.method === 'GET' && path === '/api/admin/roles') {
        requireRole(session, ['ADMIN']);
        return sendJson(200, database.prepare('SELECT id, name FROM roles ORDER BY id').all());
      }
      if (request.method === 'GET' && path === '/api/admin/devices') {
        requireRole(session, ['ADMIN']);
        return sendJson(200, listDevices(database));
      }
      if (request.method === 'GET' && path === '/api/admin/sessions') {
        requireRole(session, ['ADMIN']);
        return sendJson(200, listSessions(database));
      }
      if (request.method === 'GET' && path === '/api/admin/security-events') {
        requireRole(session, ['ADMIN']);
        return sendJson(200, listSecurityEvents(database));
      }
      if (request.method === 'GET' && path === '/api/admin/sync-conflicts') {
        requireRole(session, ['ADMIN']);
        const conflicts = database.prepare(`SELECT c.*, u.full_name AS user_name, u.username
          FROM sync_conflicts c JOIN users u ON u.id = c.user_id
          ORDER BY c.last_attempt_at DESC LIMIT 500`).all();
        return sendJson(200, conflicts.map((conflict) => ({
          ...conflict, payload: JSON.parse(conflict.payload_json),
        })));
      }
      if (request.method === 'POST' && path === '/api/admin/users') {
        requireRole(session, ['ADMIN']);
        const created = await createUser(database, await readJson());
        recordSecurityEvent(database, session.userId, created.id, 'USER_CREATED', {
          role: created.role, routeId: created.routeId,
        });
        return sendJson(201, created);
      }
      const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (request.method === 'PATCH' && userMatch) {
        requireRole(session, ['ADMIN']);
        const userId = userMatch[1];
        const before = database.prepare('SELECT full_name, role_id, route_id, active FROM users WHERE id = ?').get(userId);
        const updated = updateUser(database, userId, await readJson(), session.userId);
        const changes = {};
        if (before && before.role_id !== updated.role) changes.role = { from: before.role_id, to: updated.role };
        if (before && before.route_id !== updated.routeId) changes.routeId = { from: before.route_id, to: updated.routeId };
        if (before && Number(before.active) !== updated.active) changes.active = { from: Number(before.active), to: updated.active };
        if (before && before.full_name !== updated.name) changes.nameChanged = true;
        if (Object.keys(changes).length) recordSecurityEvent(database, session.userId, userId, 'USER_UPDATED', changes);
        return sendJson(200, updated);
      }
      const passwordMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
      if (request.method === 'PUT' && passwordMatch) {
        requireRole(session, ['ADMIN']);
        const result = await resetPassword(database, passwordMatch[1], (await readJson()).password);
        recordSecurityEvent(database, session.userId, passwordMatch[1], 'USER_PASSWORD_RESET');
        return sendJson(200, result);
      }
      const approveMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/devices\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approveMatch) {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        const result = approveDevice(database, approveMatch[1], approveMatch[2], body.revokePrevious !== false);
        recordSecurityEvent(database, session.userId, approveMatch[1], 'DEVICE_APPROVED', {
          deviceId: approveMatch[2], previousDevicesRevoked: result.previousDevicesRevoked,
        });
        return sendJson(200, result);
      }
      const deviceStatusMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/devices\/([^/]+)\/(block|revoke)$/);
      if (request.method === 'POST' && deviceStatusMatch) {
        requireRole(session, ['ADMIN']);
        const status = deviceStatusMatch[3] === 'block' ? 'BLOCKED' : 'REVOKED';
        const result = setDeviceStatus(database, deviceStatusMatch[1], deviceStatusMatch[2], status);
        recordSecurityEvent(database, session.userId, deviceStatusMatch[1], `DEVICE_${status}`, {
          deviceId: deviceStatusMatch[2],
        });
        return sendJson(200, result);
      }
      const sessionMatch = path.match(/^\/api\/admin\/sessions\/([^/]+)\/revoke$/);
      if (request.method === 'POST' && sessionMatch) {
        requireRole(session, ['ADMIN']);
        const subject = database.prepare(`SELECT user_id FROM sessions
          WHERE substr(token_hash, 1, 16) = ?`).get(sessionMatch[1]);
        const result = revokeSession(database, sessionMatch[1]);
        recordSecurityEvent(database, session.userId, subject?.user_id, 'SESSION_REVOKED', {
          sessionId: sessionMatch[1],
        });
        return sendJson(200, result);
      }
      if (path.startsWith('/api/') && session && !canUseRoute(session, request.method, path, undefined)) {
        const permittedByBody = request.method === 'POST' && path === '/api/sync';
        if (!permittedByBody) throw new AuthError(403, 'FORBIDDEN', 'Tu rol no tiene permiso para esta función');
      }
      if (request.method === 'GET' && path === '/api/products') {
        let warehouseId = null;
        if (session.role !== 'ADMIN') {
          const assignment = database.prepare(`SELECT w.id FROM routes r
            JOIN warehouses w ON w.id = r.warehouse_id
            WHERE r.id = ? AND r.active = 1 AND w.active = 1`).get(session.routeId);
          if (!assignment) throw new AuthError(403, 'ROUTE_NOT_ASSIGNED', 'El usuario no tiene una ruta y bodega activas');
          warehouseId = assignment.id;
        }
        return sendJson(200, listProducts(database, session.role === 'ADMIN', url.searchParams.get('q') || '', warehouseId));
      }
      if (request.method === 'GET' && path === '/api/clients') {
        if (session.role !== 'ADMIN' && !session.routeId) throw new AuthError(403, 'ROUTE_NOT_ASSIGNED', 'El usuario no tiene una ruta asignada');
        return sendJson(200, listClients(database, session.role === 'ADMIN', session.role === 'ADMIN' ? null : session.routeId,
          url.searchParams.get('q') || ''));
      }
      if (request.method === 'GET' && path === '/api/my/sales') {
        return sendJson(200, listSellerSales(database, session.userId));
      }
      if (request.method === 'GET' && path === '/api/inventory') {
        const warehouseId = url.searchParams.get('warehouseId');
        if (warehouseId && !database.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(warehouseId)) {
          throw new Error('La bodega no existe o está inactiva');
        }
        return sendJson(200, getInventory(database, warehouseId));
      }
      if (request.method === 'GET' && path === '/api/inventory/unassigned') {
        return sendJson(200, getUnassignedInventory(database));
      }
      if (request.method === 'GET' && path === '/api/movements') return sendJson(200, listMovements(database));
      if (request.method === 'GET' && path === '/api/sales') return sendJson(200, listSales(database));
      if (request.method === 'GET' && path === '/api/closings') return sendJson(200, listClosings(database));
      if (request.method === 'GET' && path === '/api/reports/rotation') {
        return sendJson(200, getRotation(database, url.searchParams.get('from') || '', url.searchParams.get('to') || ''));
      }
      if (request.method === 'GET' && path === '/api/reports/sales') {
        return sendJson(200, listSalesReport(database, {
          from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '',
          sellerId: url.searchParams.get('sellerId') || '', routeId: url.searchParams.get('routeId') || '',
          clientId: url.searchParams.get('clientId') || '', productId: url.searchParams.get('productId') || '',
        }));
      }
      if (request.method === 'GET' && path === '/api/closing-details') {
        const closingDate = url.searchParams.get('date');
        return sendJson(200, getClosingDetails(database, closingDate || ''));
      }
      if (request.method === 'POST' && path === '/api/products') {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        return sendJson(201, saveProduct(database, body, session.userId));
      }
      const clientMatch = path.match(/^\/api\/clients\/([^/]+)$/);
      if (request.method === 'PUT' && clientMatch) {
        requireRole(session, ['ADMIN']);
        return sendJson(200, updateClient(database, clientMatch[1], await readJson(), session.userId));
      }
      if (request.method === 'PATCH' && clientMatch) {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        if (typeof body.active !== 'boolean') throw new Error('El estado del cliente no es válido');
        return sendJson(200, setClientStatus(database, clientMatch[1], body.active, session.userId));
      }
      if (request.method === 'PUT' && path.startsWith('/api/products/')) {
        requireRole(session, ['ADMIN']);
        const id = path.slice('/api/products/'.length);
        return sendJson(200, updateProduct(database, id, await readJson(), session.userId));
      }
      const productMatch = path.match(/^\/api\/products\/([^/]+)$/);
      if (request.method === 'PATCH' && productMatch) {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        return sendJson(200, setProductStatus(database, productMatch[1], body.active));
      }
      if (request.method === 'POST' && path === '/api/sync') {
        const body = await readJson();
        if (!Array.isArray(body.operations) || body.operations.length > 100) throw new Error('El lote de sincronización no es válido (máximo 100 operaciones)');
        if (!canUseRoute(session, request.method, path, body)) throw new AuthError(403, 'FORBIDDEN', 'Tu rol no puede sincronizar este tipo de operación');
        const results = body.operations.map((operation) => {
          try {
            const result = processOperation(database, operation, session.userId);
            if (typeof operation?.id === 'string') {
              database.prepare('DELETE FROM sync_conflicts WHERE user_id = ? AND operation_id = ?')
                .run(session.userId, operation.id);
            }
            return { id: operation?.id, ok: true, result };
          } catch (error) {
            recordSyncConflict(database, session.userId, operation, error);
            return { id: operation?.id, ok: false, error: error.message };
          }
        });
        return sendJson(200, { results });
      }
      if (request.method === 'POST' && path === '/api/dispatch') {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        return sendJson(200, dispatchSale(database, body.id, body.operatingDate, session.userId));
      }
      const preorderMatch = path.match(/^\/api\/preorders\/([^/]+)$/);
      if (request.method === 'PUT' && preorderMatch) {
        requireRole(session, ['ADMIN']);
        return sendJson(200, updatePreorder(database, preorderMatch[1], await readJson()));
      }
      if (request.method === 'POST' && path === '/api/cancel-preorder') {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        return sendJson(200, cancelPreorder(database, body.id));
      }
      if (request.method === 'POST' && path === '/api/closings') {
        requireRole(session, ['ADMIN']);
        const body = await readJson();
        return sendJson(201, closeDay(database, body.closingDate, session.userId));
      }
      if (request.method === 'GET' && path === '/api/export') {
        requireRole(session, ['ADMIN']);
        const resource = url.searchParams.get('resource');
        const exports = {
          products: () => listProducts(database),
          inventory: () => getInventory(database),
          unassigned: () => getUnassignedInventory(database),
          clients: () => listClients(database, true),
          movements: () => listMovements(database),
          sales: () => listSales(database),
          salesReport: () => listSalesReport(database, {
            from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '',
            sellerId: url.searchParams.get('sellerId') || '', routeId: url.searchParams.get('routeId') || '',
            clientId: url.searchParams.get('clientId') || '', productId: url.searchParams.get('productId') || '',
          }),
          closings: () => listClosings(database),
          closing: () => getClosingDetails(database, url.searchParams.get('date') || ''),
          rotation: () => getRotation(database, url.searchParams.get('from') || '', url.searchParams.get('to') || ''),
        };
        if (!exports[resource]) return sendJson(400, { error: 'Tipo de exportación no válido' });
        const data = exports[resource]();
        const rows = data.map((row) => Object.values(row));
        const headings = data.length ? Object.keys(data[0]) : ['sin_datos'];
        const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
        const csv = `\uFEFF${[headings, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}`;
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="dresa-${resource}.csv"`,
        });
        return response.end(csv);
      }
      if (request.method === 'GET') {
        const requested = path === '/' || path === '/vendedor' ? 'index.html' : normalize(path).replace(/^([\\/]+|\.\.[\\/])+/g, '');
        const file = resolve(publicRoot, requested);
        if (!file.startsWith(`${publicRoot}\\`) && file !== publicRoot) return sendJson(404, { error: 'No encontrado' });
        if (!existsSync(file) || !statSync(file).isFile()) return sendJson(404, { error: 'No encontrado' });
        response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return createReadStream(file).pipe(response);
      }
      sendJson(404, { error: 'No encontrado' });
    } catch (error) {
      const status = error instanceof AuthError ? error.status
        : error instanceof SyntaxError ? 400
          : Number.isInteger(error.status) ? error.status : 422;
      sendJson(status, { error: error.message || 'Error interno del servidor', ...(error instanceof AuthError ? { code: error.code } : {}) });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const tlsCertificate = process.env.DRESA_TLS_CERT;
  const tlsKey = process.env.DRESA_TLS_KEY;
  if (Boolean(tlsCertificate) !== Boolean(tlsKey)) {
    throw new Error('Configura juntos DRESA_TLS_CERT y DRESA_TLS_KEY para habilitar HTTPS');
  }
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const database = createDatabase(databasePath);
  const bootstrapToken = createBootstrapToken();
  const app = createApp(database, { bootstrapToken });
  if (authStatus(database).setupRequired) {
    console.log(`Token único para crear el primer administrador de DRESA: ${bootstrapToken}`);
  }
  const listener = tlsCertificate
    ? createHttpsServer({ cert: readFileSync(tlsCertificate), key: readFileSync(tlsKey) }, app)
    : app;
  const host = '0.0.0.0';
  listener.listen(port, host, () => {
    const protocol = tlsCertificate ? 'https' : 'http';
    console.log(`DRESA disponible en ${protocol}://localhost:${port}`);
    console.log(`Escuchando en ${host}:${port}`);
    console.log(`Base de datos: ${databasePath}`);
  });
}
