import { promisify } from 'node:util';
import {
  createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual,
} from 'node:crypto';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'dresa_session';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const HASH_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const now = () => new Date().toISOString();
let dummyPasswordHash;

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new AuthError(422, 'WEAK_PASSWORD', 'La contraseña debe tener entre 12 y 256 caracteres');
  }
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    throw new AuthError(422, 'INVALID_USERNAME', 'El usuario debe tener entre 3 y 40 caracteres: letras, números, punto, guion o guion bajo');
  }
  return username.toLowerCase();
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, HASH_OPTIONS);
  return `scrypt$32768$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, cost, saltHex, hashHex] = String(encoded).split('$');
  if (algorithm !== 'scrypt' || cost !== '32768' || !/^[a-f0-9]{32}$/.test(saltHex || '') ||
      !/^[a-f0-9]{128}$/.test(hashHex || '')) return false;
  try {
    const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), 64, HASH_OPTIONS);
    return safeEqual(derived, Buffer.from(hashHex, 'hex'));
  } catch (error) {
    throw new Error('No se pudo verificar la contraseña', { cause: error });
  }
}

export function createBootstrapToken() {
  return randomBytes(32).toString('base64url');
}

export function authStatus(db) {
  return { setupRequired: Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count) === 0 };
}

export function getSessionCookieName() {
  return SESSION_COOKIE;
}

export function readSession(db, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const session = db.prepare(`SELECT s.token_hash, s.user_id, s.device_id, s.csrf_token, s.expires_at, s.last_seen,
      u.full_name, u.username, u.role_id AS role, u.active AS user_active,
      d.status AS device_status, u.route_id,
      r.name AS route_name, r.active AS route_active, r.warehouse_id,
      w.name AS warehouse_name, w.active AS warehouse_active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
    LEFT JOIN routes r ON r.id = u.route_id
    LEFT JOIN warehouses w ON w.id = r.warehouse_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL`).get(tokenHash);
  if (!session || !session.user_active || session.device_status !== 'APPROVED' || session.expires_at <= now() ||
      (session.role !== 'ADMIN' && (!session.route_id || !session.route_active || !session.warehouse_id || !session.warehouse_active))) return null;
  return {
    tokenHash: session.token_hash, userId: session.user_id, deviceId: session.device_id,
    fullName: session.full_name, username: session.username, role: session.role,
    routeId: session.route_id, routeName: session.route_name,
    routeActive: session.route_active, warehouseId: session.warehouse_id,
    warehouseName: session.warehouse_name, warehouseActive: session.warehouse_active,
    expiresAt: session.expires_at, csrfToken: session.csrf_token,
  };
}

export function requestDeviceId(request) {
  const value = request.headers['x-dresa-device'];
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) {
    throw new AuthError(422, 'INVALID_DEVICE', 'No se recibió un identificador de dispositivo válido');
  }
  return value;
}

export function sessionCookie(token, secure = true) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure = true) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export async function createFirstAdmin(db, input, expectedBootstrapToken, deviceId, userAgent) {
  if (!expectedBootstrapToken || !safeEqual(input?.bootstrapToken || '', expectedBootstrapToken)) {
    throw new AuthError(403, 'INVALID_BOOTSTRAP_TOKEN', 'El token de configuración no es válido');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw new AuthError(422, 'INVALID_NAME', 'El nombre es obligatorio');
  const username = validateUsername(input.username);
  const passwordHash = await hashPassword(input.password);
  return createUserAndSession(db, {
    fullName: name, username, passwordHash, role: 'ADMIN', deviceId,
    deviceName: typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, 120) || 'Matriz' : 'Matriz',
    userAgent,
  }, 'APPROVED');
}

export async function login(db, input, userAgent) {
  const username = validateUsername(input?.username);
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  const password = typeof input?.password === 'string' && input.password.length <= 256 ? input.password : '';
  if (!dummyPasswordHash) dummyPasswordHash = hashPassword(randomBytes(24).toString('base64url'));
  const encodedHash = user ? user.password_hash : await dummyPasswordHash;
  const matches = await verifyPassword(password, encodedHash);
  if (!matches || !user.active) throw new AuthError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos');
  if (user.role_id !== 'ADMIN' && !db.prepare(`SELECT 1 FROM routes r JOIN warehouses w ON w.id = r.warehouse_id
      WHERE r.id = ? AND r.active = 1 AND w.active = 1`).get(user.route_id)) {
    throw new AuthError(403, 'ROUTE_NOT_ASSIGNED', 'El usuario no tiene una ruta y bodega activas asignadas');
  }

  const deviceId = input.deviceId;
  if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(deviceId)) {
    throw new AuthError(422, 'INVALID_DEVICE', 'No se recibió un identificador de dispositivo válido');
  }
  const deviceName = typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, 120) || 'Dispositivo' : 'Dispositivo';
  const previousDevice = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, user.id);
  if (!previousDevice) {
    db.prepare(`INSERT INTO devices (id, user_id, name, user_agent, status, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?)`).run(deviceId, user.id, deviceName, String(userAgent || '').slice(0, 500), now());
    throw new AuthError(403, 'DEVICE_PENDING', 'Este dispositivo requiere autorización de la matriz');
  }
  if (previousDevice.status !== 'APPROVED') {
    const messages = {
      PENDING: 'Este dispositivo requiere autorización de la matriz',
      BLOCKED: 'Este dispositivo está bloqueado; contacte a la matriz',
      REVOKED: 'Este dispositivo fue revocado; solicite autorización a la matriz',
    };
    throw new AuthError(403, `DEVICE_${previousDevice.status}`, messages[previousDevice.status] || 'Dispositivo no autorizado');
  }
  return createSession(db, user, deviceId);
}

function createSession(db, user, deviceId) {
  const timestamp = now();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, user.id);
    if (!device || device.status !== 'APPROVED') throw new AuthError(403, 'DEVICE_NOT_APPROVED', 'El dispositivo no está autorizado');
    const active = db.prepare(`SELECT token_hash, device_id FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`).get(user.id, timestamp);
    if (active && active.device_id !== deviceId) {
      throw new AuthError(409, 'ACTIVE_SESSION', 'El usuario ya tiene una sesión activa en otro dispositivo');
    }
    if (active) db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(timestamp, active.token_hash);
    db.prepare(`INSERT INTO sessions (token_hash, user_id, device_id, csrf_token, created_at, expires_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(tokenHash, user.id, deviceId, csrfToken, timestamp, expiresAt, timestamp);
    db.prepare('UPDATE devices SET last_seen = ?, name = ? WHERE id = ? AND user_id = ?')
      .run(timestamp, device.name, deviceId, user.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    token, session: {
      id: tokenHash.slice(0, 16), user: {
        id: user.id, fullName: user.full_name, username: user.username, role: user.role_id,
      }, deviceId, expiresAt, csrfToken,
    },
  };
}

function createUserAndSession(db, input, deviceStatus) {
  const userId = randomUUID();
  const createdAt = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO users (id, full_name, username, password_hash, role_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(userId, input.fullName, input.username, input.passwordHash, input.role, createdAt);
    db.prepare(`INSERT INTO devices (id, user_id, name, user_agent, status, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.deviceId, userId, input.deviceName, String(input.userAgent || '').slice(0, 500), deviceStatus, createdAt, createdAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return createSession(db, {
    id: userId, full_name: input.fullName, username: input.username, role_id: input.role,
  }, input.deviceId);
}

export async function createUser(db, input) {
  const fullName = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!fullName || fullName.length > 120) throw new AuthError(422, 'INVALID_NAME', 'El nombre es obligatorio');
  const username = validateUsername(input.username);
  const role = input.role;
  if (!['ADMIN', 'VENDEDOR', 'PREVENTA'].includes(role)) throw new AuthError(422, 'INVALID_ROLE', 'El rol no es válido');
  const routeId = validateUserRoute(db, role, input.routeId);
  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO users (id, full_name, username, password_hash, role_id, route_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, fullName, username, passwordHash, role, routeId, now());
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) throw new AuthError(409, 'USERNAME_EXISTS', 'Ese nombre de usuario ya existe');
    throw error;
  }
  return { id, name: fullName, username, role, routeId, active: 1 };
}

function validateUserRoute(db, role, routeId) {
  if (role === 'ADMIN') {
    if (routeId != null && routeId !== '') throw new AuthError(422, 'INVALID_ROUTE', 'La cuenta ADMIN no se asigna a una ruta');
    return null;
  }
  if (typeof routeId !== 'string' || !routeId.trim()) {
    throw new AuthError(422, 'ROUTE_REQUIRED', 'Asigna una ruta activa con bodega antes de habilitar al vendedor');
  }
  const route = db.prepare(`SELECT r.id FROM routes r JOIN warehouses w ON w.id = r.warehouse_id
    WHERE r.id = ? AND r.active = 1 AND w.active = 1`).get(routeId.trim());
  if (!route) throw new AuthError(422, 'INVALID_ROUTE', 'La ruta debe estar activa y asociada a una bodega activa');
  return route.id;
}

export async function resetPassword(db, userId, password) {
  const passwordHash = await hashPassword(password);
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  if (!result.changes) throw new AuthError(404, 'USER_NOT_FOUND', 'El usuario no existe');
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), userId);
  return { id: userId, sessionsRevoked: true };
}

export function updateUser(db, userId, input, currentUserId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new AuthError(404, 'USER_NOT_FOUND', 'El usuario no existe');
  const fullName = input?.name == null ? user.full_name : String(input.name).trim();
  if (!fullName || fullName.length > 120) throw new AuthError(422, 'INVALID_NAME', 'El nombre es obligatorio');
  let active = user.active;
  if (input?.active != null) {
    if (input.active === true || input.active === 1 || input.active === '1') active = 1;
    else if (input.active === false || input.active === 0 || input.active === '0') active = 0;
    else throw new AuthError(422, 'INVALID_USER_STATUS', 'El estado del usuario no es válido');
  }
  const role = input?.role || user.role_id;
  if (!['ADMIN', 'VENDEDOR', 'PREVENTA'].includes(role)) throw new AuthError(422, 'INVALID_ROLE', 'El rol no es válido');
  const routeId = input?.routeId === undefined ? user.route_id : input.routeId;
  if (userId === currentUserId &&
      (role !== user.role_id || active !== user.active || routeId !== user.route_id)) {
    throw new AuthError(403, 'SELF_PERMISSION_CHANGE', 'No puedes modificar tus propios permisos o estado');
  }
  const assignedRouteId = validateUserRoute(db, role, routeId);
  if (user.role_id === 'ADMIN' && (active !== 1 || role !== 'ADMIN')) {
    const others = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role_id = 'ADMIN' AND active = 1 AND id != ?").get(userId).count);
    if (others === 0) throw new AuthError(409, 'LAST_ADMIN', 'Debe quedar al menos un administrador activo');
  }
  db.prepare('UPDATE users SET full_name = ?, role_id = ?, active = ?, route_id = ? WHERE id = ?')
    .run(fullName, role, active, assignedRouteId, userId);
  if (!active || role !== user.role_id || assignedRouteId !== user.route_id || userId === currentUserId) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), userId);
  }
  return { id: userId, name: fullName, role, routeId: assignedRouteId, active };
}

export function listUsers(db) {
  return db.prepare(`SELECT u.id, u.full_name AS name, u.username, u.role_id AS role, u.active, u.created_at,
      u.route_id, r.name AS route_name, r.warehouse_id, w.name AS warehouse_name,
      (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.status = 'APPROVED') AS approved_devices,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
    FROM users u LEFT JOIN routes r ON r.id = u.route_id
    LEFT JOIN warehouses w ON w.id = r.warehouse_id ORDER BY u.full_name`).all(now());
}

export function recordSecurityEvent(db, actorUserId, subjectUserId, eventType, details = {}) {
  db.prepare(`INSERT INTO security_events
      (id, actor_user_id, subject_user_id, event_type, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), actorUserId || null, subjectUserId || null, eventType,
      JSON.stringify(details), now());
}

export function listSecurityEvents(db, limit = 500) {
  return db.prepare(`SELECT e.id, e.event_type, e.details_json, e.created_at,
      actor.full_name AS actor_name, subject.full_name AS subject_name,
      e.actor_user_id, e.subject_user_id
    FROM security_events e
    LEFT JOIN users actor ON actor.id = e.actor_user_id
    LEFT JOIN users subject ON subject.id = e.subject_user_id
    ORDER BY e.created_at DESC LIMIT ?`).all(limit)
    .map((event) => ({ ...event, details: JSON.parse(event.details_json) }));
}

export function listDevices(db) {
  return db.prepare(`SELECT d.id, d.user_id, u.full_name AS user_name, u.username, u.role_id AS role,
      d.name, d.user_agent, d.status, d.created_at, d.last_seen
    FROM devices d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC`).all();
}

export function listSessions(db) {
  return db.prepare(`SELECT substr(s.token_hash, 1, 16) AS id, s.user_id, u.full_name AS user_name,
      u.username, u.role_id AS role, s.device_id, d.name AS device_name, s.created_at, s.last_seen, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
    WHERE s.revoked_at IS NULL AND s.expires_at > ? ORDER BY s.last_seen DESC`).all(now());
}

export function approveDevice(db, userId, deviceId, revokePrevious = true) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, userId);
  if (!device) throw new AuthError(404, 'DEVICE_NOT_FOUND', 'El dispositivo no existe');
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE devices SET status = 'APPROVED' WHERE id = ? AND user_id = ?").run(deviceId, userId);
    if (revokePrevious) {
      db.prepare("UPDATE devices SET status = 'REVOKED' WHERE user_id = ? AND id != ? AND status = 'APPROVED'")
        .run(device.user_id, deviceId);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND device_id != ? AND revoked_at IS NULL')
        .run(timestamp, device.user_id, deviceId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { deviceId, status: 'APPROVED', previousDevicesRevoked: revokePrevious };
}

export function setDeviceStatus(db, userId, deviceId, status) {
  if (!['BLOCKED', 'REVOKED', 'APPROVED'].includes(status)) throw new AuthError(422, 'INVALID_DEVICE_STATUS', 'El estado del dispositivo no es válido');
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, userId);
  if (!device) throw new AuthError(404, 'DEVICE_NOT_FOUND', 'El dispositivo no existe');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE devices SET status = ? WHERE id = ? AND user_id = ?').run(status, deviceId, userId);
    if (status !== 'APPROVED') {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL')
        .run(now(), deviceId, userId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { deviceId, status };
}

export function revokeSession(db, shortId) {
  const result = db.prepare("UPDATE sessions SET revoked_at = ? WHERE substr(token_hash, 1, 16) = ? AND revoked_at IS NULL")
    .run(now(), shortId);
  if (!result.changes) throw new AuthError(404, 'SESSION_NOT_FOUND', 'La sesión ya no existe o fue revocada');
  return { sessionId: shortId, revoked: true };
}

export function recordLoginFailure(limits, key) {
  if (limits.size > 10_000) {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [entryKey, entry] of limits) {
      if (entry.firstAt < cutoff && entry.blockedUntil < Date.now()) limits.delete(entryKey);
    }
  }
  const entry = limits.get(key) || { count: 0, firstAt: Date.now(), blockedUntil: 0 };
  if (entry.blockedUntil > Date.now()) return Math.ceil((entry.blockedUntil - Date.now()) / 1000);
  if (Date.now() - entry.firstAt > 15 * 60 * 1000) {
    entry.count = 0;
    entry.firstAt = Date.now();
  }
  entry.count += 1;
  if (entry.count >= 8) entry.blockedUntil = Date.now() + 15 * 60 * 1000;
  limits.set(key, entry);
  return entry.blockedUntil > Date.now() ? Math.ceil((entry.blockedUntil - Date.now()) / 1000) : 0;
}

export function clearLoginFailures(limits, key) {
  limits.delete(key);
}
