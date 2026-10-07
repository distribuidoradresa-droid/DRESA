let sellerMode = location.pathname === '/vendedor';
let currentUser = null;
let offlineSession = false;
const AUTH_CACHE_KEY = 'dresa:authorized-session';
const API_CACHE_PREFIX = 'dresa:api:';
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (value) => new Intl.NumberFormat('es-HN', { style: 'currency', currency: 'HNL' }).format(Number(value || 0));
const displayTime = (value) => value ? new Intl.DateTimeFormat('es-HN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const dateToday = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const databasePromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('dresa-offline', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('queue', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const queueAll = async () => {
  const db = await databasePromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction('queue').objectStore('queue').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};
const queuePut = async (item) => {
  const db = await databasePromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction('queue', 'readwrite').objectStore('queue')
      .put({ ...item, ownerId: item.ownerId || currentUser?.id || null });
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};
const queueRemove = async (id) => {
  const db = await databasePromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction('queue', 'readwrite').objectStore('queue').delete(id);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};
let state = { products: [], clients: [], inventory: [], unassignedInventory: [], sales: [], movements: [], closings: [], syncConflicts: [], routes: [], warehouses: [], users: [] };
let noticeTimer;
function deviceId() {
  let id = localStorage.getItem('dresa:device-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('dresa:device-id', id);
  }
  return id;
}

function authCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(AUTH_CACHE_KEY));
    return cached && cached.expiresAt && Date.parse(cached.expiresAt) > Date.now() &&
      cached.deviceId === deviceId() ? cached : null;
  } catch {
    return null;
  }
}

function saveAuthCache(user, device, expiresAt, csrfToken) {
  const cached = { ...user, deviceId: device, expiresAt, csrfToken };
  localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(cached));
  return cached;
}

function apiDataCacheKey(path) {
  const scope = [currentUser?.id || 'anonymous', currentUser?.role || 'unknown', currentUser?.routeId || 'matrix']
    .map((value) => encodeURIComponent(value)).join(':');
  return `${API_CACHE_PREFIX}${scope}:${path}`;
}

function clearApiDataCache() {
  const keys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(API_CACHE_PREFIX) || key?.startsWith('dresa:/api/')) keys.push(key);
  }
  keys.forEach((key) => localStorage.removeItem(key));
}

function clearLegacyApiDataCache() {
  const keys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith('dresa:/api/')) keys.push(key);
  }
  keys.forEach((key) => localStorage.removeItem(key));
}

function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-DRESA-Device', currentUser?.deviceId || deviceId());
  if (currentUser?.csrfToken && options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
    headers.set('X-DRESA-CSRF', currentUser.csrfToken);
  }
  return fetch(path, { ...options, headers });
}

function showAuthGate(message = '') {
  $('#auth-gate').classList.remove('hidden');
  $('.app-shell').classList.add('hidden');
  $('#seller-main').classList.add('hidden');
  $('#auth-message').textContent = message;
}

async function authenticate() {
  clearLegacyApiDataCache();
  const cached = authCache();
  if (!navigator.onLine) {
    if (cached) {
      currentUser = cached;
      offlineSession = true;
      return true;
    }
    showAuthGate('Conéctate a la red local de DRESA para iniciar sesión por primera vez.');
    $('#login-form').classList.remove('hidden');
    return false;
  }
  try {
    const statusResponse = await fetch('/api/auth/status');
    if (!statusResponse.ok) throw new Error(`Error HTTP ${statusResponse.status}`);
    const status = await statusResponse.json();
    if (status.setupRequired) {
      showAuthGate();
      $('#bootstrap-form').classList.remove('hidden');
      return false;
    }
    const response = await fetch('/api/auth/me', { headers: { 'X-DRESA-Device': deviceId() } });
    if (response.ok) {
      const session = await response.json();
      currentUser = saveAuthCache(session.user, session.deviceId, session.expiresAt, session.csrfToken);
      offlineSession = false;
      return true;
    }
    if (response.status !== 401) throw new Error(`Error HTTP ${response.status}`);
    localStorage.removeItem(AUTH_CACHE_KEY);
    showAuthGate();
    $('#login-form').classList.remove('hidden');
    return false;
  } catch (error) {
    if (cached) {
      currentUser = cached;
      offlineSession = true;
      return true;
    }
    showAuthGate('No fue posible conectar con la matriz. Las operaciones locales existentes se conservaron.');
    $('#login-form').classList.remove('hidden');
    return false;
  }
}

async function sendAuthForm(form, endpoint) {
  const message = $('#auth-message');
  message.textContent = '';
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.deviceId = deviceId();
  payload.deviceName = `${navigator.platform || 'Dispositivo'} · ${/Mobi|Android/i.test(navigator.userAgent) ? 'Móvil' : 'Navegador'}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DRESA-Device': payload.deviceId },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      message.textContent = body.error || 'No fue posible iniciar sesión.';
      return;
    }
    location.reload();
  } catch {
    message.textContent = 'No fue posible conectar con la matriz. Verifica la red local.';
  }
}

async function logout() {
  try {
    if (navigator.onLine) await apiFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    clearApiDataCache();
    localStorage.removeItem(AUTH_CACHE_KEY);
    location.reload();
  }
}

async function downloadExport(link) {
  try {
    const response = await apiFetch(link.href);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Error HTTP ${response.status}`);
    }
    const filename = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/i)?.[1] || 'dresa-export.csv';
    const objectUrl = URL.createObjectURL(await response.blob());
    const download = document.createElement('a');
    download.href = objectUrl;
    download.download = filename;
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    notice(error.message, true);
  }
}
const daysBefore = (count) => {
  const date = new Date();
  date.setDate(date.getDate() - count);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

function notice(message, error = false) {
  const element = $('#notice');
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => element.classList.add('hidden'), 4200);
}

function setConnection(online) {
  for (const element of $$('.connection')) {
    element.classList.toggle('online', online);
    element.classList.toggle('offline', !online);
    element.innerHTML = `<i></i>${online ? 'Conectado' : 'Sin conexión'}`;
  }
}

async function getData(path, fallback = []) {
  try {
    const response = await apiFetch(path);
    if (response.status === 401) {
      localStorage.removeItem(AUTH_CACHE_KEY);
      showAuthGate('La sesión venció o fue revocada. Inicia sesión nuevamente; las operaciones sin sincronizar se conservaron.');
      $('#login-form').classList.remove('hidden');
      return fallback;
    }
    if (!response.ok) throw new Error(`Error HTTP ${response.status}`);
    const result = await response.json();
    localStorage.setItem(apiDataCacheKey(path), JSON.stringify(result));
    setConnection(true);
    return result;
  } catch (error) {
    if (!(error instanceof TypeError) && navigator.onLine) throw error;
    setConnection(false);
    try {
      const cached = JSON.parse(localStorage.getItem(apiDataCacheKey(path)));
      if (!Array.isArray(cached) || path !== '/api/clients' || currentUser?.role === 'ADMIN') return cached ?? fallback;
      return cached.filter((client) => client.active && client.route_id === currentUser?.routeId);
    } catch {
      return fallback;
    }
  }
}

async function submitOperation(operation) {
  const response = await apiFetch('/api/sync', {
    method: 'POST',     headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operations: [operation] }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Error HTTP ${response.status}`);
  }
  const { results } = await response.json();
  const result = results[0];
  if (!result?.ok) throw new Error(result?.error || 'No se pudo guardar la operación');
  return result.result;
}

async function syncQueue() {
  if (!navigator.onLine || !currentUser) {
    setConnection(false);
    return;
  }
  if (offlineSession) {
    try {
      const response = await fetch('/api/auth/me', { headers: { 'X-DRESA-Device': currentUser.deviceId } });
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem(AUTH_CACHE_KEY);
          showAuthGate('La sesión venció o fue revocada. Las operaciones pendientes se conservaron.');
          $('#login-form').classList.remove('hidden');
        }
        setConnection(false);
        return;
      }
      const session = await response.json();
      if (session.user.role !== currentUser.role || session.user.routeId !== currentUser.routeId) {
        saveAuthCache(session.user, session.deviceId, session.expiresAt, session.csrfToken);
        location.reload();
        return;
      }
      currentUser = saveAuthCache(session.user, session.deviceId, session.expiresAt, session.csrfToken);
      offlineSession = false;
    } catch {
      setConnection(false);
      return;
    }
  }
  const queue = (await queueAll()).filter((item) => item.ownerId === currentUser.id)
    .sort((left, right) => String(left.queuedAt || '').localeCompare(String(right.queuedAt || '')) ||
      String(left.id).localeCompare(String(right.id)));
  if (!queue.length) {
    setConnection(true);
    await refresh();
    return;
  }
  try {
    for (let offset = 0; offset < queue.length; offset += 100) {
      const batch = queue.slice(offset, offset + 100);
      const response = await apiFetch('/api/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: batch.map(({ id, kind, payload }) => ({ id, kind, payload })) }),
      });
      if (response.status === 401) {
        const failedAt = new Date().toISOString();
        for (const item of batch) await queuePut({ ...item, failedAt, error: 'Sesión revocada o vencida; inicia sesión para sincronizar' });
        localStorage.removeItem(AUTH_CACHE_KEY);
        showAuthGate('La sesión venció o fue revocada. Las operaciones pendientes se conservaron.');
        $('#login-form').classList.remove('hidden');
        return;
      }
      if (!response.ok) throw new Error(`Error HTTP ${response.status}`);
      const { results } = await response.json();
      for (const result of results) {
        const queued = batch.find((item) => item.id === result.id);
        if (!queued) continue;
        if (result.ok) await queueRemove(result.id);
        else await queuePut({ ...queued, error: result.error, failedAt: new Date().toISOString() });
      }
    }
    setConnection(true);
    await refresh();
    await renderPending();
  } catch {
    setConnection(false);
  }
}

async function saveOrQueue(operation, localValue = null) {
  if (navigator.onLine) {
    try {
      const result = await submitOperation(operation);
      return { ...result, queued: false };
    } catch (error) {
      if (error instanceof TypeError || !navigator.onLine || error.message.includes('HTTP 401')) {
        await queuePut({ ...operation, queuedAt: new Date().toISOString(), error: error.message.includes('HTTP 401') ? 'Sesión vencida; pendiente de reautenticación' : '' });
        setConnection(false);
        await renderPending();
        return { id: operation.id, queued: true, localValue };
      }
      throw error;
    }
  }
  await queuePut({ ...operation, queuedAt: new Date().toISOString(), error: '' });
  await renderPending();
  return { id: operation.id, queued: true, localValue };
}

function operation(kind, payload, id = crypto.randomUUID()) {
  return { id, kind, payload };
}

async function refresh() {
  const common = [getData('/api/products'), getData('/api/clients')];
  const administrative = currentUser?.role === 'ADMIN'
    ? [getData('/api/inventory'), getData('/api/sales'), getData('/api/movements'), getData('/api/closings'),
      getData('/api/admin/sync-conflicts'), getData('/api/admin/routes'), getData('/api/admin/warehouses'),
      getData('/api/inventory/unassigned'), getData('/api/admin/users')]
    : [getData('/api/my/sales')];
  const data = await Promise.all([...common, ...administrative]);
  const [products, clients, inventory = [], sales = [], movements = [], closings = [], syncConflicts = [], routes = [], warehouses = []] = data;
  const sellerSales = currentUser?.role === 'ADMIN' ? sales : data[2];
  const unassignedInventory = currentUser?.role === 'ADMIN' ? data[9] || [] : [];
  const users = currentUser?.role === 'ADMIN' ? data[10] || [] : [];
  const permittedClients = currentUser?.role === 'ADMIN' ? clients : clients.filter((client) => client.active);
  const queued = (await queueAll()).filter((item) => item.ownerId === currentUser?.id);
  const queuedClients = queued.filter((item) => item.kind === 'client').map((item) => ({
    id: item.id, name: item.payload.businessName || item.payload.name || item.payload.fullName,
    business_name: item.payload.businessName || item.payload.name || '',
    full_name: item.payload.fullName || '', tax_id: item.payload.taxId || '',
    phone: item.payload.phone, address: item.payload.address, reference: item.payload.reference,
    email: item.payload.email, notes: item.payload.notes, route_id: item.payload.routeId || 'route-001',
    route_name: 'Ruta 001', active: 1, offline: true,
  }));
  const byId = new Map([...permittedClients, ...queuedClients].map((client) => [client.id, client]));
  state = {
    products, clients: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sales: sellerSales || [],
    inventory, unassignedInventory, movements, closings, syncConflicts, users,
    routes: currentUser?.role === 'ADMIN' ? routes : [],
    warehouses: currentUser?.role === 'ADMIN' ? warehouses : [],
  };
  if (!sellerMode) renderMatrix();
  else {
    renderSellerSelects();
    renderSellerHistory();
  }
  await renderPending();
}

async function adminRequest(path, options) {
  const response = await apiFetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Error HTTP ${response.status}`);
  return body;
}

function renderSecurity(users, devices, sessions, events, queuedCount) {
  $('#security-user-count').textContent = `${users.length} cuentas`;
  $('#security-device-count').textContent = `${devices.length} dispositivos`;
  $('#security-session-count').textContent = `${sessions.length} sesiones`;
  $('#security-event-count').textContent = `${events.length} eventos`;
  $('#security-sync-status').textContent = `Conexión a matriz: ${navigator.onLine ? 'disponible' : 'sin conexión'} · Operaciones pendientes en este dispositivo: ${queuedCount}`;
  $('#security-users-body').innerHTML = users.map((user) => `<tr>
    <td><strong>${escapeHtml(user.name)}</strong></td><td>${escapeHtml(user.username)}</td>
    <td><select class="security-role-select" data-role-user="${escapeHtml(user.id)}" ${user.id === currentUser.id ? 'disabled title="No puedes cambiar tus propios permisos"' : ''}>
      <option value="ADMIN" ${user.role === 'ADMIN' ? 'selected' : ''}>ADMIN / MATRIZ</option>
      <option value="VENDEDOR" ${user.role === 'VENDEDOR' ? 'selected' : ''}>VENDEDOR</option>
      <option value="PREVENTA" ${user.role === 'PREVENTA' ? 'selected' : ''}>PREVENTA</option>
    </select></td>
    <td><select class="security-route-select" data-route-user="${escapeHtml(user.id)}" ${user.id === currentUser.id ? 'disabled title="No puedes cambiar tus propios permisos"' : ''}><option value="">Sin ruta</option>${state.routes
      .filter((route) => route.active && route.warehouse_active)
      .map((route) => `<option value="${escapeHtml(route.id)}" ${user.route_id === route.id ? 'selected' : ''}>${escapeHtml(route.name)} · ${escapeHtml(route.warehouse_name)}</option>`).join('')}</select>
      <br><span class="count-label">${escapeHtml(user.warehouse_name || 'Sin bodega')}</span></td>
    <td><span class="status-pill ${user.active ? '' : 'cancelled'}">${user.active ? 'Activo' : 'Inactivo'}</span></td>
    <td>${Number(user.approved_devices)}</td><td>${Number(user.active_sessions)}</td>
    <td><button class="text-button security-user-toggle" data-id="${escapeHtml(user.id)}" data-active="${Number(user.active)}" ${user.id === currentUser.id ? 'disabled title="No puedes cambiar tu propio estado"' : ''}>${user.active ? 'Desactivar' : 'Activar'}</button>
      <button class="text-button security-user-role" data-id="${escapeHtml(user.id)}" ${user.id === currentUser.id ? 'disabled title="No puedes cambiar tus propios permisos"' : ''}>Aplicar rol</button>
      <button class="text-button security-user-password" data-id="${escapeHtml(user.id)}">Restablecer contraseña</button></td>
    </tr>`).join('') || '<tr><td colspan="8">No hay usuarios.</td></tr>';
  $('#security-devices-body').innerHTML = devices.map((device) => {
    const action = device.status === 'PENDING' || device.status === 'REVOKED'
      ? `<button class="text-button security-device-action" data-id="${escapeHtml(device.id)}" data-user-id="${escapeHtml(device.user_id)}" data-action="approve">Autorizar y revocar anterior</button>`
      : device.status === 'APPROVED'
        ? `<button class="text-button security-device-action" data-id="${escapeHtml(device.id)}" data-user-id="${escapeHtml(device.user_id)}" data-action="block">Bloquear</button> <button class="text-button security-device-action" data-id="${escapeHtml(device.id)}" data-user-id="${escapeHtml(device.user_id)}" data-action="revoke">Revocar</button>`
        : `<button class="text-button security-device-action" data-id="${escapeHtml(device.id)}" data-user-id="${escapeHtml(device.user_id)}" data-action="approve">Autorizar y revocar anterior</button>`;
    return `<tr><td>${escapeHtml(device.user_name)}<br><span class="count-label">${escapeHtml(device.username)}</span></td>
      <td>${escapeHtml(device.name)}</td><td>${escapeHtml(device.id)}</td>
      <td><span class="status-pill ${device.status === 'APPROVED' ? '' : device.status === 'PENDING' ? 'pending' : 'cancelled'}">${escapeHtml(device.status)}</span></td>
      <td>${escapeHtml(device.last_seen || '—')}</td><td>${action}</td></tr>`;
  }).join('') || '<tr><td colspan="6">No hay dispositivos registrados.</td></tr>';
  $('#security-sessions-body').innerHTML = sessions.map((session) => `<tr>
    <td>${escapeHtml(session.user_name)}<br><span class="count-label">${escapeHtml(session.username)}</span></td>
    <td>${escapeHtml(session.device_name)}</td><td>${escapeHtml(session.last_seen)}</td><td>${escapeHtml(session.expires_at)}</td>
    <td><button class="text-button security-session-revoke" data-id="${escapeHtml(session.id)}">Revocar sesión</button></td></tr>`
  ).join('') || '<tr><td colspan="5">No hay sesiones activas.</td></tr>';
  $('#security-events-body').innerHTML = events.map((event) => `<tr>
    <td>${escapeHtml(event.created_at)}</td><td>${escapeHtml(event.event_type)}</td>
    <td>${escapeHtml(event.actor_name || 'Sistema / no autenticado')}</td>
    <td>${escapeHtml(event.subject_name || '—')}</td>
    <td>${escapeHtml(JSON.stringify(event.details || {}))}</td></tr>`)
    .join('') || '<tr><td colspan="5">No hay eventos registrados.</td></tr>';
}

function renderRouteAdmin() {
  const warehouseOptions = state.warehouses.filter((warehouse) => warehouse.active)
    .map((warehouse) => `<option value="${escapeHtml(warehouse.id)}">${escapeHtml(warehouse.code)} · ${escapeHtml(warehouse.name)}</option>`).join('');
  const initialWarehouse = $('#product-form [name="initialWarehouseId"]');
  if (initialWarehouse) {
    const selected = initialWarehouse.value;
    initialWarehouse.innerHTML = `<option value="">Asignar automáticamente si hay una sola bodega</option>${warehouseOptions}`;
    initialWarehouse.value = selected;
  }
  for (const select of [$('#route-form [name="warehouseId"]')]) {
    if (!select) continue;
    const selected = select.value;
    select.innerHTML = `<option value="">Selecciona una bodega activa</option>${warehouseOptions}`;
    select.value = selected;
  }
  const clientRoute = $('#client-form [name="routeId"]');
  if (clientRoute) {
    const selected = clientRoute.value;
    clientRoute.innerHTML = `<option value="">Selecciona una ruta</option>${state.routes
      .map((route) => `<option value="${escapeHtml(route.id)}">${escapeHtml(route.name)}${route.active ? '' : ' · inactiva'}</option>`).join('')}`;
    clientRoute.value = selected;
    if (!selected && currentUser?.routeId) clientRoute.value = currentUser.routeId;
  }
  const newUserRoute = $('#user-form [name="routeId"]');
  if (newUserRoute) {
    const selected = newUserRoute.value;
    newUserRoute.innerHTML = `<option value="">Selecciona una ruta activa</option>${state.routes
      .filter((route) => route.active && route.warehouse_active)
      .map((route) => `<option value="${escapeHtml(route.id)}">${escapeHtml(route.name)} · ${escapeHtml(route.warehouse_name)}</option>`).join('')}`;
    newUserRoute.value = selected;
  }
  $('#warehouse-count').textContent = `${state.warehouses.length} bodegas`;
  $('#warehouses-body').innerHTML = state.warehouses.map((warehouse) => `<tr>
    <td>${escapeHtml(warehouse.code)}</td><td>${escapeHtml(warehouse.name)}</td><td>${Number(warehouse.route_count)}</td>
    <td><span class="status-pill ${warehouse.active ? '' : 'cancelled'}">${warehouse.active ? 'Activa' : 'Inactiva'}</span></td>
    <td><button class="text-button warehouse-edit" data-id="${escapeHtml(warehouse.id)}">Editar</button></td></tr>`)
    .join('') || '<tr><td colspan="5">Aún no hay bodegas. Registra la bodega real de DRESA.</td></tr>';
  $('#route-count').textContent = `${state.routes.length} rutas`;
  $('#routes-body').innerHTML = state.routes.map((route) => `<tr>
    <td>${escapeHtml(route.name)}<br><span class="count-label">${escapeHtml(route.id)}</span></td>
    <td>${escapeHtml(route.warehouse_name || 'Sin bodega')}</td><td>${Number(route.active_users)}</td><td>${Number(route.active_clients)}</td>
    <td><span class="status-pill ${route.active ? '' : 'cancelled'}">${route.active ? 'Activa' : 'Inactiva'}</span></td>
    <td><button class="text-button route-edit" data-id="${escapeHtml(route.id)}">Editar</button></td></tr>`)
    .join('') || '<tr><td colspan="6">No hay rutas.</td></tr>';
  const warehouseFilter = $('#inventory-warehouse-filter');
  if (warehouseFilter) {
    const selected = warehouseFilter.value;
    warehouseFilter.innerHTML = `<option value="">Todas las bodegas</option><option value="unassigned">Sin bodega asignada</option>${state.warehouses
      .filter((warehouse) => warehouse.active)
      .map((warehouse) => `<option value="${escapeHtml(warehouse.id)}">${escapeHtml(warehouse.code)} · ${escapeHtml(warehouse.name)}</option>`).join('')}`;
    warehouseFilter.value = selected;
  }
  const reportForm = $('#sales-report-form');
  if (reportForm) {
    const options = [
      [reportForm.elements.sellerId, state.users.filter((user) => user.role !== 'ADMIN')
        .map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`).join('')],
      [reportForm.elements.routeId, state.routes.map((route) =>
        `<option value="${escapeHtml(route.id)}">${escapeHtml(route.name)}</option>`).join('')],
      [reportForm.elements.clientId, state.clients.map((client) =>
        `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}</option>`).join('')],
      [reportForm.elements.productId, state.products.map((product) =>
        `<option value="${escapeHtml(product.id)}">${escapeHtml(product.code)} · ${escapeHtml(product.name)}</option>`).join('')],
    ];
    for (const [select, html] of options) {
      const selected = select.value;
      const first = select.options[0].outerHTML;
      select.innerHTML = `${first}${html}`;
      select.value = selected;
    }
  }
}

function renderSellerHistory() {
  const history = state.sales || [];
  $('#seller-history-count').textContent = `${history.length} operaciones`;
  $('#seller-history-body').innerHTML = history.map((sale) => `<tr>
    <td>${escapeHtml(sale.operating_date)}<br><span class="count-label">${escapeHtml(displayTime(sale.occurred_at))}</span></td><td>${escapeHtml(sale.client_name)}</td>
    <td>${escapeHtml(sale.kind)}</td><td>${money(sale.total)}</td><td>${escapeHtml(sale.status)}</td></tr>`)
    .join('') || '<tr><td colspan="5">Todavía no hay operaciones sincronizadas.</td></tr>';
}

async function refreshSecurity() {
  if (!navigator.onLine || offlineSession) {
    notice('La administración de usuarios requiere conexión con la matriz.', true);
    return;
  }
  try {
    const [users, devices, sessions, events, queue] = await Promise.all([
      adminRequest('/api/admin/users'), adminRequest('/api/admin/devices'),
      adminRequest('/api/admin/sessions'), adminRequest('/api/admin/security-events'), queueAll(),
    ]);
    renderSecurity(users, devices, sessions, events, queue.filter((item) => item.ownerId === currentUser.id).length);
  } catch (error) {
    notice(error.message, true);
  }
}

function renderMatrix() {
  renderRouteAdmin();
  $('#matrix-route-tag').textContent = `●  ${currentUser.routeName || 'Matriz'}`;
  const search = $('#product-search').value.trim().toLocaleLowerCase();
  const products = state.products.filter((product) => !search || [
    product.code, product.name, product.short_name, product.description, product.brand,
    product.category, product.family, product.weight, product.unit,
  ].some((value) => String(value || '').toLocaleLowerCase().includes(search)));
  $('#products-body').innerHTML = products.map((product) => `<tr>
    <td>${escapeHtml(product.code)}</td>
    <td><strong>${escapeHtml(product.short_name || product.name)}</strong><br><span class="count-label">${escapeHtml(product.description || 'Sin descripción')}</span></td>
    <td>${escapeHtml([product.brand, product.weight].filter(Boolean).join(' · ') || '—')}</td>
    <td>${escapeHtml(product.category || '—')}<br><span class="count-label">${escapeHtml(product.family || '—')}</span></td>
    <td>${escapeHtml(product.unit)}</td><td>${money(product.price)}</td><td class="stock-value">${Number(product.stock)}</td>
    <td><span class="status-pill ${product.active ? '' : 'cancelled'}">${product.active ? 'Activo' : 'Inactivo'}</span></td>
    <td><button class="text-button edit-product" data-id="${escapeHtml(product.id)}" type="button">Editar</button>
      <button class="text-button toggle-product" data-id="${escapeHtml(product.id)}" data-active="${Number(product.active)}" type="button">${product.active ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('') ||
    `<tr><td colspan="9">${search ? 'No hay productos que coincidan con la búsqueda.' : 'No hay productos registrados.'}</td></tr>`;
  $('#product-count').textContent = `${products.length} de ${state.products.length} productos`;
  const movementProduct = $('#movement-form [name="productId"]');
  if (movementProduct) {
    const selected = movementProduct.value;
    movementProduct.innerHTML = `<option value="">Seleccionar producto</option>${state.products
      .filter((product) => product.active)
      .map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.code)} · ${escapeHtml(product.short_name || product.name)} · stock ${Number(product.stock)} ${escapeHtml(product.unit)}</option>`)
      .join('')}`;
    movementProduct.value = selected;
  }
  $('#inventory-body').innerHTML = state.inventory.map((product) => {
    const previous = Number(product.stock) - Number(product.entries) + Number(product.exits) + Number(product.sales) - Number(product.adjustments) - Number(product.returns);
    return `<tr><td>${escapeHtml(product.code)}</td><td>${escapeHtml(product.name)}</td><td>${previous}</td>
      <td>${Number(product.entries)}</td><td>${Number(product.exits)}</td><td>${Number(product.sales)}</td>
      <td>${Number(product.adjustments)}</td><td>${Number(product.returns)}</td><td class="stock-value">${Number(product.stock)}</td></tr>`;
  }).join('') || '<tr><td colspan="9">No hay inventario disponible.</td></tr>';
  if ($('#inventory-warehouse-filter')?.value === 'unassigned') {
    $('#inventory-body').innerHTML = state.unassignedInventory.map((product) => `<tr>
      <td>${escapeHtml(product.code)}</td><td>${escapeHtml(product.name)}</td><td>—</td>
      <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td class="stock-value">${Number(product.stock)}</td></tr>`)
      .join('') || '<tr><td colspan="9">No hay existencias históricas sin bodega asignada.</td></tr>';
  }
  $('#movements-body').innerHTML = state.movements.map((movement) => `<tr>
    <td>${escapeHtml(movement.operating_date)}<br><span class="count-label">${escapeHtml(displayTime(movement.created_at))}</span></td><td>${escapeHtml(movement.product_code)} · ${escapeHtml(movement.product_name)}</td>
    <td>${escapeHtml(movement.warehouse_name || 'Sin bodega asignada')}</td><td>${escapeHtml(movement.kind)}</td><td class="${movement.quantity_delta < 0 ? 'pending-error' : ''}">${Number(movement.quantity_delta)}</td>
    <td>${escapeHtml(movement.note || '—')}</td><td>${escapeHtml(movement.actor_name || 'Matriz / anterior a auditoría')}</td></tr>`).join('') || '<tr><td colspan="6">Todavía no hay movimientos.</td></tr>';
  $('#sales-body').innerHTML = state.sales.map((sale) => {
    const lines = parseLines(sale.lines);
    const action = `${sale.status === 'PENDING' ? `${sale.kind === 'PREVENTA' ? `<button class="text-button edit-preorder" data-id="${escapeHtml(sale.id)}" type="button">Editar</button> ` : ''}<button class="text-button dispatch-sale" data-id="${escapeHtml(sale.id)}" type="button">Despachar</button> <button class="text-button cancel-sale" data-id="${escapeHtml(sale.id)}" type="button">Cancelar</button> ` : ''}<button class="text-button sale-detail-button" data-id="${escapeHtml(sale.id)}" type="button">Detalle</button>`;
    return `<tr><td>${escapeHtml(sale.operating_date)}<br><span class="count-label">${escapeHtml(displayTime(sale.occurred_at))}</span></td><td>${escapeHtml(sale.client_name)}</td>
      <td>${escapeHtml(sale.seller_name || 'Matriz / anterior a auditoría')}${sale.dispatched_by ? `<br><span class="count-label">Despachó: ${escapeHtml(sale.dispatcher_name || 'Matriz')}</span>` : ''}</td><td>${escapeHtml(sale.kind)}</td>
      <td>${lines.map((line) => `${escapeHtml(line.name)} × ${Number(line.quantity)}<br><span class="count-label">${money(line.unitPrice)} × ${Number(line.quantity)} = ${money(Number(line.unitPrice) * Number(line.quantity))}</span>`).join('<br>')}</td>
      <td>${escapeHtml(sale.reference || '—')}</td><td>${money(sale.total)}</td>
      <td><span class="status-pill ${sale.status === 'PENDING' ? 'pending' : sale.status === 'CANCELLED' ? 'cancelled' : ''}">${escapeHtml(sale.status)}</span></td><td>${action}</td></tr>`;
  }).join('') || '<tr><td colspan="9">Todavía no hay ventas.</td></tr>';
  const movementWarehouse = $('#movement-form [name="warehouseId"]');
  if (movementWarehouse) {
    const selected = movementWarehouse.value;
    movementWarehouse.innerHTML = `<option value="">Seleccionar bodega</option>${state.warehouses.filter((warehouse) => warehouse.active)
      .map((warehouse) => `<option value="${escapeHtml(warehouse.id)}">${escapeHtml(warehouse.code)} · ${escapeHtml(warehouse.name)}</option>`).join('')}`;
    movementWarehouse.value = selected || (state.warehouses.length === 1 ? state.warehouses[0].id : '');
  }
  $('#sync-conflict-count').textContent = `${state.syncConflicts.length} pendientes`;
  $('#sync-conflicts-body').innerHTML = state.syncConflicts.map((conflict) => {
    const payload = conflict.payload || {};
    const detail = conflict.operation_kind === 'sale'
      ? (payload.lines || []).map((line) => {
        const product = state.products.find((item) => item.id === line.productId);
        return `${product ? `${product.code} · ${product.name}` : line.productId} × ${Number(line.quantity)}`;
      }).join('; ')
      : payload.name || payload.productId || '—';
    return `<tr><td>${escapeHtml(conflict.last_attempt_at)}</td><td>${escapeHtml(conflict.user_name)}<br><span class="count-label">${escapeHtml(conflict.username)}</span></td>
      <td>${escapeHtml(conflict.operation_kind)}<br><span class="count-label">${escapeHtml(conflict.operation_id)}</span></td>
      <td>${escapeHtml(detail)}</td><td>${Number(conflict.attempts)}</td><td>${escapeHtml(conflict.error)}</td></tr>`;
  }).join('') || '<tr><td colspan="6">No hay operaciones rechazadas pendientes de revisión.</td></tr>';
  const clientQuery = ($('#client-search')?.value || '').trim().toLocaleLowerCase();
  const filteredClients = state.clients.filter((client) => !clientQuery || [
    client.tax_id, client.name, client.business_name, client.full_name, client.phone, client.email,
    client.address, client.reference, client.notes, client.route_name,
  ].some((value) => String(value || '').toLocaleLowerCase().includes(clientQuery)));
  $('#clients-body').innerHTML = filteredClients.map((client) => `<tr>
    <td>${escapeHtml(client.tax_id || '—')}</td>
    <td><strong>${escapeHtml(client.business_name || client.name)}</strong>${client.full_name ? `<br><span class="count-label">${escapeHtml(client.full_name)}</span>` : ''}${client.offline ? ' <span class="pill">Pendiente</span>' : ''}</td>
    <td>${escapeHtml(client.phone || '—')}${client.email ? `<br><span class="count-label">${escapeHtml(client.email)}</span>` : ''}</td>
    <td>${escapeHtml(client.address || '—')}${client.reference ? `<br><span class="count-label">${escapeHtml(client.reference)}</span>` : ''}</td>
    <td>${escapeHtml(client.route_name || 'Ruta 001')}</td>
    <td><span class="status-pill ${client.active ? '' : 'cancelled'}">${client.active ? 'ACTIVO' : 'INACTIVO'}</span></td>
    <td>${escapeHtml(client.notes || '—')}</td>
    <td>${escapeHtml(client.actor_name || 'Matriz / anterior a auditoría')}</td>
    <td>${client.offline ? 'Pendiente de sincronizar' : `<button class="text-button client-edit" data-id="${escapeHtml(client.id)}" type="button">Editar</button>
      <button class="text-button client-status" data-id="${escapeHtml(client.id)}" data-active="${Number(client.active)}" type="button">${client.active ? 'Desactivar' : 'Activar'}</button>`}</td></tr>`).join('') ||
    '<tr><td colspan="9">Todavía no hay clientes.</td></tr>';
  $('#client-count').textContent = `${filteredClients.length} de ${state.clients.length} clientes`;
  $('#closings-body').innerHTML = state.closings.map((closing) => `<tr><td>${escapeHtml(closing.closing_date)}</td>
    <td>${escapeHtml(closing.actor_name || 'Matriz / anterior a auditoría')}</td>
    <td><button class="text-button view-closing" data-date="${escapeHtml(closing.closing_date)}" type="button">Ver detalle</button></td></tr>`).join('') ||
    '<tr><td colspan="3">Todavía no hay cierres.</td></tr>';
  renderRotation(state.rotation || []);
  const productOptions = state.products.filter((product) => product.active).map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.code)} · ${escapeHtml(product.name)} (stock ${Number(product.stock)})</option>`).join('');
  $$('select[name="productId"]').forEach((select) => { select.innerHTML = `<option value="">Seleccionar producto</option>${productOptions}`; });
}

function renderRotation(rows) {
  const body = $('#rotation-body');
  if (!body) return;
  body.innerHTML = rows.map((row) => {
    const activity = Number(row.movement_count) === 0 ? 'Sin movimientos' :
      Number(row.sold) === 0 ? 'Movimiento sin ventas' : 'Con ventas';
    return `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td>
      <td class="stock-value">${Number(row.stock)}</td><td>${Number(row.sold)}</td>
      <td>${escapeHtml(row.last_sale || '—')}</td><td>${activity}</td></tr>`;
  }).join('') || '<tr><td colspan="6">No hay productos para el período seleccionado.</td></tr>';
}

function parseLines(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value || [];
  } catch {
    return [];
  }
}

function renderSellerSelects() {
  const options = state.clients.map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.business_name || client.name)}${client.offline ? ' · pendiente de sincronizar' : ''}</option>`).join('');
  const select = $('#seller-form select[name="clientId"]');
  if (select) {
    const selected = select.value;
    select.innerHTML = `<option value="">Seleccionar cliente</option>${options}`;
    select.value = selected;
  }
  $$('.sale-line select').forEach((select) => {
    const selected = select.value;
    select.innerHTML = `<option value="">Seleccionar producto</option>${state.products.filter((item) => item.active).map((item) =>
      `<option value="${escapeHtml(item.id)}" data-price="${Number(item.price)}" data-stock="${Number(item.stock)}">${escapeHtml(item.code)} · ${escapeHtml(item.short_name || item.name)} · ${money(item.price)} sin IVA · stock ${Number(item.stock)}</option>`).join('')}`;
    select.value = selected;
  });
}

async function renderPending() {
  const queued = (await queueAll()).filter((item) => item.ownerId === currentUser?.id);
  const count = $('#pending-count');
  if (count) count.textContent = String(queued.length);
  const list = $('#pending-list');
  if (list) list.innerHTML = queued.map((item) => `<div class="pending-item">
    <span><strong>${escapeHtml(item.kind === 'client'
      ? item.payload.businessName || item.payload.name || item.payload.fullName || 'Cliente nuevo'
      : item.kind === 'sale' ? `${item.payload.kind} · ${item.payload.operatingDate}` : 'Movimiento de inventario')}</strong>
      ${item.error ? `<br><span class="pending-error">${escapeHtml(item.error)}</span>` : ''}</span>
    <span class="pill">${item.error ? 'Revisar' : 'Pendiente'}</span></div>`).join('') || '<p class="field-note">Todas las operaciones están sincronizadas.</p>';
}

async function migrateUnownedOperations() {
  for (const item of await queueAll()) {
    if (!item.ownerId) await queuePut({ ...item, ownerId: currentUser.id });
  }
}

function showView(name) {
  $$('.view').forEach((view) => view.classList.toggle('hidden', view.id !== `view-${name}`));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
}

function resetProductForm() {
  $('#product-form').reset();
  $('#product-form [name="id"]').value = '';
  $('#product-form [name="stock"]').value = '0';
  $('#product-form [name="stock"]').disabled = false;
  $('#product-form [name="unit"]').value = 'unidad';
  $('#product-form [name="initialWarehouseId"]').value = '';
  $('#product-form-title').textContent = 'Agregar producto';
  $('#product-form button[type="submit"]').textContent = 'Guardar producto';
  $('#product-cancel').classList.add('hidden');
  $('#product-form [name="stock"]').disabled = false;
}

function resetClientForm() {
  const form = $('#client-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.routeId.value = currentUser?.role === 'ADMIN'
    ? state.routes.find((route) => route.active)?.id || ''
    : currentUser?.routeId || '';
  form.elements.active.value = '1';
  $('#client-form-title').textContent = 'Registrar cliente';
  $('#client-form button[type="submit"]').textContent = 'Guardar cliente';
  $('#client-cancel').classList.add('hidden');
  $('#gps-status').textContent = 'Ubicación opcional; requiere permiso del dispositivo.';
}

function addSaleLine() {
  const container = document.createElement('div');
  container.className = 'sale-line';
  container.innerHTML = `<label>Producto<select required><option value="">Seleccionar producto</option></select></label>
    <label>Cantidad<input type="number" min="0.001" step="0.001" required placeholder="0"></label>
    <button type="button" class="button button-light remove-line" aria-label="Eliminar producto">×</button>`;
  $('#sale-lines').append(container);
  renderSellerSelects();
  renderSaleSummary();
}

function addPreorderEditLine(line = {}) {
  const row = document.createElement('div');
  row.className = 'preorder-edit-line form-row';
  const productLabel = document.createElement('label');
  productLabel.textContent = 'Producto';
  const productSelect = document.createElement('select');
  productSelect.name = 'productId';
  productSelect.required = true;
  productSelect.innerHTML = `<option value="">Seleccionar producto</option>${state.products.filter((product) => product.active)
    .map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.code)} · ${escapeHtml(product.short_name || product.name)}</option>`).join('')}`;
  productSelect.value = line.productId || '';
  productLabel.append(productSelect);
  const quantityLabel = document.createElement('label');
  quantityLabel.textContent = 'Cantidad';
  const quantityInput = document.createElement('input');
  quantityInput.name = 'quantity';
  quantityInput.type = 'number';
  quantityInput.min = '0.001';
  quantityInput.step = '0.001';
  quantityInput.required = true;
  quantityInput.value = line.quantity == null ? '' : String(line.quantity);
  quantityLabel.append(quantityInput);
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'button button-light remove-preorder-edit-line';
  removeButton.textContent = 'Quitar';
  row.append(productLabel, quantityLabel, removeButton);
  $('#preorder-edit-lines').append(row);
}

function beginPreorderEdit(sale) {
  const form = $('#preorder-edit-form');
  form.elements.id.value = sale.id;
  form.elements.clientId.innerHTML = `<option value="">Seleccionar cliente</option>${state.clients.filter((client) => client.active)
    .map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.business_name || client.name)}</option>`).join('')}`;
  form.elements.clientId.value = sale.client_id;
  form.elements.operatingDate.value = sale.operating_date;
  form.elements.reference.value = sale.reference || '';
  $('#preorder-edit-lines').replaceChildren();
  parseLines(sale.lines).forEach((line) => addPreorderEditLine({ productId: line.productId, quantity: line.quantity }));
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetPreorderEdit() {
  const form = $('#preorder-edit-form');
  form.reset();
  form.elements.id.value = '';
  $('#preorder-edit-lines').replaceChildren();
  form.classList.add('hidden');
}

function renderSaleSummary() {
  const rows = $$('.sale-line').map((line) => {
    const select = $('select', line);
    const product = state.products.find((item) => item.id === select.value);
    const quantity = Number($('input', line).value);
    if (!product || !Number.isFinite(quantity) || quantity <= 0) return null;
    return { product, quantity, subtotal: product.price * quantity };
  }).filter(Boolean);
  const subtotal = rows.reduce((sum, row) => sum + row.subtotal, 0);
  const isAutoventa = $('#seller-form [name="kind"]:checked')?.value === 'AUTOVENTA';
  const stockWarning = isAutoventa && rows.some((row) => row.quantity > Number(row.product.stock))
    ? '<span class="pending-error">La cantidad supera el stock disponible; no se podrá confirmar la autoventa.</span><br>' : '';
  const mode = isAutoventa ? 'Autoventa: se validará y descontará stock al guardar.' : 'Preventa: el stock se validará al despachar.';
  $('#sale-summary').innerHTML = `${rows.map((row) =>
    `${escapeHtml(row.product.short_name || row.product.name)}: ${money(row.product.price)} × ${row.quantity} = ${money(row.subtotal)}`).join('<br>') || 'Selecciona productos y cantidades.'}<br>${stockWarning}Subtotal / total sin IVA: <strong>${money(subtotal)}</strong><br>${mode}`;
}

async function saveInlineClient() {
  const form = $('#seller-form');
  const fullName = form.elements.newClientFullName.value.trim();
  const businessName = form.elements.newClientBusinessName.value.trim();
  if (!fullName && !businessName) {
    notice('Escribe el nombre completo o el nombre del negocio.', true);
    return;
  }
  const id = crypto.randomUUID();
  const payload = {
    taxId: form.elements.newClientTaxId.value.trim(),
    fullName, businessName,
    phone: form.elements.newClientPhone.value.trim(),
    email: form.elements.newClientEmail.value.trim(),
    address: form.elements.newClientAddress.value.trim(),
    reference: form.elements.newClientReference.value.trim(),
    notes: form.elements.newClientNotes.value.trim(),
    routeId: currentUser.routeId,
  };
  try {
    const result = await saveOrQueue(operation('client', payload, id), payload);
    state.clients.push({
      id, name: businessName || fullName, business_name: businessName, full_name: fullName,
      tax_id: payload.taxId, ...payload, route_name: currentUser.routeName, active: 1, offline: result.queued,
    });
    renderSellerSelects();
    $('#seller-form select[name="clientId"]').value = id;
    $('#seller-new-client').classList.add('hidden');
    $$('#seller-form [name^="newClient"]').forEach((input) => { input.value = ''; });
    notice(result.queued ? 'Cliente guardado en el teléfono; se sincronizará al volver la conexión.' : 'Cliente guardado.');
    if (!sellerMode) renderMatrix();
  } catch (error) {
    notice(error.message, true);
  }
}

async function initialize() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="/api/export"]');
    if (!link) return;
    event.preventDefault();
    downloadExport(link);
  });
  $('#login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sendAuthForm(event.currentTarget, '/api/auth/login');
  });
  $('#bootstrap-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sendAuthForm(event.currentTarget, '/api/auth/bootstrap');
  });
  $('#logout-matrix').addEventListener('click', logout);
  $('#logout-seller').addEventListener('click', logout);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((error) => console.error('No se pudo registrar el modo sin conexión:', error));
  if (!await authenticate()) return;
  await migrateUnownedOperations();
  $('#auth-gate').classList.add('hidden');
  sellerMode = location.pathname === '/vendedor' || currentUser.role !== 'ADMIN';
  $$('.admin-only').forEach((element) => {
    if (!element.classList.contains('view')) element.classList.toggle('hidden', currentUser.role !== 'ADMIN');
  });
  document.body.classList.toggle('seller-mode', sellerMode);
  if (sellerMode) {
    $('.app-shell').classList.add('hidden');
    $('#seller-main').classList.remove('hidden');
    $('#seller-route-tag').textContent = `${currentUser.routeName || 'Ruta sin asignar'}${currentUser.warehouseName ? ` · ${currentUser.warehouseName}` : ''}`;
    if (currentUser.role === 'PREVENTA') {
      const autoventa = $('#seller-form input[value="AUTOVENTA"]');
      autoventa.closest('label').classList.add('hidden');
      $('#seller-form input[value="PREVENTA"]').checked = true;
    }
  } else {
    $('#seller-main').classList.add('hidden');
    $('.app-shell').classList.remove('hidden');
    $('#movement-form [name="operatingDate"]').value = dateToday();
    $('#closing-form [name="closingDate"]').value = dateToday();
    $('#rotation-form [name="from"]').value = daysBefore(29);
    $('#rotation-form [name="to"]').value = dateToday();
    $('#sales-report-form [name="from"]').value = daysBefore(29);
    $('#sales-report-form [name="to"]').value = dateToday();
    $('#navigation').addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (button && (!['users', 'routes'].includes(button.dataset.view) || currentUser.role === 'ADMIN')) showView(button.dataset.view);
    });
    $('#user-form [name="role"]').addEventListener('change', (event) => {
      const required = event.currentTarget.value !== 'ADMIN';
      $('#user-route-field').classList.toggle('hidden', !required);
      $('#user-form [name="routeId"]').required = required;
    });
    $('#refresh-security').addEventListener('click', refreshSecurity);
    $('#user-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const payload = Object.fromEntries(new FormData(form).entries());
      if (payload.role === 'ADMIN') payload.routeId = '';
      try {
        await adminRequest('/api/admin/users', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        form.reset();
        await refreshSecurity();
        notice('Usuario creado. Su dispositivo requiere autorización de la matriz.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#security-users-body').addEventListener('click', async (event) => {
      const toggle = event.target.closest('.security-user-toggle');
      const applyRole = event.target.closest('.security-user-role');
      const reset = event.target.closest('.security-user-password');
      if (!toggle && !applyRole && !reset) return;
      const id = (toggle || applyRole || reset).dataset.id;
      try {
        if (toggle) {
          const nextActive = toggle.dataset.active !== '1';
          const verb = nextActive ? 'activar' : 'desactivar';
          if (!confirm(`¿Deseas ${verb} esta cuenta?`)) return;
          await adminRequest(`/api/admin/users/${encodeURIComponent(id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: nextActive }),
          });
        } else if (applyRole) {
          const role = $(`[data-role-user="${CSS.escape(id)}"]`).value;
          const routeId = role === 'ADMIN' ? null : $(`[data-route-user="${CSS.escape(id)}"]`)?.value || '';
          if (!confirm(`¿Aplicar rol ${role}${routeId ? ` en ${state.routes.find((route) => route.id === routeId)?.name || routeId}` : ''}? La sesión actual se revocará.`)) return;
          await adminRequest(`/api/admin/users/${encodeURIComponent(id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, routeId }),
          });
        } else {
          const password = prompt('Escribe una contraseña nueva (mínimo 12 caracteres).');
          if (password === null) return;
          await adminRequest(`/api/admin/users/${encodeURIComponent(id)}/password`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
          });
          notice('Contraseña restablecida; se revocaron las sesiones de la cuenta.');
        }
        await refreshSecurity();
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#refresh-routes').addEventListener('click', refresh);
    $('#warehouse-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const payload = Object.fromEntries(new FormData(form).entries());
      const id = payload.id;
      delete payload.id;
      payload.active = payload.active === '1';
      try {
        await adminRequest(id ? `/api/admin/warehouses/${encodeURIComponent(id)}` : '/api/admin/warehouses', {
          method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        form.reset();
        form.elements.id.value = '';
        $('#warehouse-form-title').textContent = 'Registrar bodega';
        $('#warehouse-form button[type="submit"]').textContent = 'Guardar bodega';
        $('#warehouse-cancel').classList.add('hidden');
        await refresh();
        notice(id ? 'Bodega actualizada.' : 'Bodega registrada.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#warehouse-cancel').addEventListener('click', () => {
      $('#warehouse-form').reset();
      $('#warehouse-form [name="id"]').value = '';
      $('#warehouse-form-title').textContent = 'Registrar bodega';
      $('#warehouse-form button[type="submit"]').textContent = 'Guardar bodega';
      $('#warehouse-cancel').classList.add('hidden');
    });
    $('#warehouses-body').addEventListener('click', (event) => {
      const button = event.target.closest('.warehouse-edit');
      const warehouse = state.warehouses.find((item) => item.id === button?.dataset.id);
      if (!warehouse) return;
      const form = $('#warehouse-form');
      form.elements.id.value = warehouse.id;
      form.elements.code.value = warehouse.code;
      form.elements.name.value = warehouse.name;
      form.elements.active.value = String(Number(warehouse.active));
      $('#warehouse-form-title').textContent = 'Editar bodega';
      $('#warehouse-form button[type="submit"]').textContent = 'Guardar cambios';
      $('#warehouse-cancel').classList.remove('hidden');
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#route-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const id = values.id || values.routeId;
      const payload = { name: values.name, warehouseId: values.warehouseId, active: values.active === '1' };
      try {
        await adminRequest(values.id ? `/api/admin/routes/${encodeURIComponent(id)}` : '/api/admin/routes', {
          method: values.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values.id ? payload : { ...payload, id }),
        });
        form.reset();
        form.elements.id.value = '';
        form.elements.routeId.disabled = false;
        $('#route-form-title').textContent = 'Registrar ruta';
        $('#route-form button[type="submit"]').textContent = 'Guardar ruta';
        $('#route-cancel').classList.add('hidden');
        await refresh();
        notice(values.id ? 'Ruta actualizada.' : 'Ruta registrada.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#route-cancel').addEventListener('click', () => {
      $('#route-form').reset();
      $('#route-form [name="id"]').value = '';
      $('#route-form [name="routeId"]').disabled = false;
      $('#route-form-title').textContent = 'Registrar ruta';
      $('#route-form button[type="submit"]').textContent = 'Guardar ruta';
      $('#route-cancel').classList.add('hidden');
    });
    $('#routes-body').addEventListener('click', (event) => {
      const button = event.target.closest('.route-edit');
      const route = state.routes.find((item) => item.id === button?.dataset.id);
      if (!route) return;
      const form = $('#route-form');
      form.elements.id.value = route.id;
      form.elements.routeId.value = route.id;
      form.elements.routeId.disabled = true;
      form.elements.name.value = route.name;
      form.elements.warehouseId.value = route.warehouse_id || '';
      form.elements.active.value = String(Number(route.active));
      $('#route-form-title').textContent = 'Editar ruta';
      $('#route-form button[type="submit"]').textContent = 'Guardar cambios';
      $('#route-cancel').classList.remove('hidden');
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#security-devices-body').addEventListener('click', async (event) => {
      const button = event.target.closest('.security-device-action');
      if (!button) return;
      const { id, userId, action } = button.dataset;
      if (!confirm(action === 'approve'
        ? '¿Autorizar este dispositivo y revocar el dispositivo anterior de ese usuario?'
        : `¿Confirmas ${action === 'block' ? 'bloquear' : 'revocar'} este dispositivo?`)) return;
      try {
        const endpoint = action === 'approve'
          ? `/api/admin/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(id)}/approve`
          : `/api/admin/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(id)}/${action}`;
        await adminRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revokePrevious: true }) });
        await refreshSecurity();
        notice(action === 'approve' ? 'Dispositivo autorizado.' : 'Dispositivo actualizado.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#security-sessions-body').addEventListener('click', async (event) => {
      const button = event.target.closest('.security-session-revoke');
      if (!button || !confirm('¿Revocar esta sesión ahora?')) return;
      try {
        await adminRequest(`/api/admin/sessions/${encodeURIComponent(button.dataset.id)}/revoke`, { method: 'POST' });
        await refreshSecurity();
        notice('Sesión revocada.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#product-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const id = form.get('id');
      const payload = Object.fromEntries(form.entries());
      payload.price = Number(payload.price);
      payload.stock = Number(payload.stock);
      try {
        const response = await apiFetch(id ? `/api/products/${encodeURIComponent(id)}` : '/api/products', {
          method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'No se pudo guardar el producto');
        resetProductForm();
        await refresh();
        notice(id ? 'Producto actualizado.' : 'Producto agregado.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#product-cancel').addEventListener('click', resetProductForm);
    $('#product-search').addEventListener('input', renderMatrix);
    $('#client-search').addEventListener('input', renderMatrix);
    $('#inventory-warehouse-filter').addEventListener('change', async (event) => {
      const warehouseId = event.currentTarget.value;
      try {
        if (warehouseId && warehouseId !== 'unassigned') {
          state.inventory = await getData(`/api/inventory?warehouseId=${encodeURIComponent(warehouseId)}`);
        } else {
          state.inventory = await getData('/api/inventory');
        }
        renderMatrix();
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#sales-report-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      const query = new URLSearchParams(Object.fromEntries(
        Object.entries(values).filter(([, value]) => value),
      ));
      try {
        const rows = await getData(`/api/reports/sales?${query}`);
        $('#sales-report-body').innerHTML = rows.map((sale) => `<tr>
          <td>${escapeHtml(sale.operating_date)}</td><td>${escapeHtml(sale.seller_name || 'Matriz / anterior')}</td>
          <td>${escapeHtml(sale.route_name)}</td><td>${escapeHtml(sale.client_name)}</td>
          <td>${parseLines(sale.lines).map((line) => `${escapeHtml(line.code)} × ${Number(line.quantity)}`).join('<br>')}</td>
          <td>${escapeHtml(sale.kind)} / ${escapeHtml(sale.status)}</td><td>${money(sale.total)}</td></tr>`)
          .join('') || '<tr><td colspan="7">No hay ventas para esos filtros.</td></tr>';
        $('#sales-report-export').href = `/api/export?resource=salesReport&${query}`;
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#sales-report-form').requestSubmit();
    $('#products-body').addEventListener('click', async (event) => {
      const button = event.target.closest('.edit-product, .toggle-product');
      if (!button) return;
      const product = state.products.find((item) => item.id === button.dataset.id);
      if (!product) return;
      if (button.classList.contains('toggle-product')) {
        try {
          await adminRequest(`/api/products/${encodeURIComponent(product.id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: !product.active }),
          });
          await refresh();
          notice(product.active ? 'Producto desactivado.' : 'Producto activado.');
        } catch (error) {
          notice(error.message, true);
        }
        return;
      }
      const form = $('#product-form');
      for (const key of ['id', 'code', 'shortName', 'description', 'brand', 'category', 'family', 'weight', 'unit', 'price', 'active']) {
        form.elements[key].value = key === 'shortName' ? product.short_name || product.name : product[key];
      }
      form.elements.stock.value = '0';
      form.elements.stock.disabled = true;
      $('#product-form-title').textContent = 'Editar producto';
      $('#product-form button[type="submit"]').textContent = 'Guardar cambios';
      $('#product-cancel').classList.remove('hidden');
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#movement-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const payload = Object.fromEntries(new FormData(form).entries());
      if (!payload.warehouseId) return notice('Selecciona una bodega para el movimiento.', true);
      payload.quantity = Number(payload.quantity);
      payload.reference = payload.note;
      try {
        await submitOperation(operation('movement', payload));
        form.reset();
        form.elements.operatingDate.value = dateToday();
        await refresh();
        notice('Movimiento registrado.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#sales-body').addEventListener('click', async (event) => {
      const dispatch = event.target.closest('.dispatch-sale');
      const cancel = event.target.closest('.cancel-sale');
      const detail = event.target.closest('.sale-detail-button');
      const editPreorder = event.target.closest('.edit-preorder');
      if (editPreorder) {
        const sale = state.sales.find((item) => item.id === editPreorder.dataset.id);
        if (sale) beginPreorderEdit(sale);
        return;
      }
      if (detail) {
        const sale = state.sales.find((item) => item.id === detail.dataset.id);
        if (!sale) return;
        const lines = parseLines(sale.lines);
        $('#sale-detail-content').innerHTML = `<p><strong>Cliente:</strong> ${escapeHtml(sale.client_name)} · <strong>Vendedor:</strong> ${escapeHtml(sale.seller_name || 'Matriz / anterior')}</p>
          <p><strong>Tipo / estado:</strong> ${escapeHtml(sale.kind)} / ${escapeHtml(sale.status)} · <strong>Fecha:</strong> ${escapeHtml(sale.operating_date)} ${escapeHtml(displayTime(sale.occurred_at))}</p>
          <p><strong>Referencia:</strong> ${escapeHtml(sale.reference || '—')}</p>
          <div class="table-wrap"><table><thead><tr><th>Código</th><th>Producto</th><th>Cantidad</th><th>Precio</th><th>Subtotal</th></tr></thead><tbody>${lines.map((line) =>
            `<tr><td>${escapeHtml(line.code)}</td><td>${escapeHtml(line.name)}</td><td>${Number(line.quantity)}</td><td>${money(line.unitPrice)}</td><td>${money(Number(line.quantity) * Number(line.unitPrice))}</td></tr>`
          ).join('')}</tbody></table></div><p><strong>Total sin IVA:</strong> ${money(sale.total)}</p>`;
        $('#sale-detail').classList.remove('hidden');
        $('#sale-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (!dispatch && !cancel) return;
      const isDispatch = Boolean(dispatch);
      const id = (dispatch || cancel).dataset.id;
      if (!confirm(isDispatch ? '¿Confirmas el despacho? Se descontará el inventario.' : '¿Cancelar esta preventa pendiente?')) return;
      try {
        const response = await apiFetch(isDispatch ? '/api/dispatch' : '/api/cancel-preorder', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isDispatch ? { id, operatingDate: dateToday() } : { id }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'No se pudo actualizar la preventa');
        await refresh();
        notice(isDispatch ? 'Preventa despachada e inventario actualizado.' : 'Preventa cancelada.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#add-preorder-edit-line').addEventListener('click', () => addPreorderEditLine());
    $('#preorder-edit-lines').addEventListener('click', (event) => {
      const remove = event.target.closest('.remove-preorder-edit-line');
      if (!remove) return;
      const rows = $$('.preorder-edit-line', $('#preorder-edit-lines'));
      if (rows.length === 1) return notice('La preventa debe conservar al menos un producto.', true);
      remove.closest('.preorder-edit-line').remove();
    });
    $('#cancel-preorder-edit').addEventListener('click', resetPreorderEdit);
    $('#preorder-edit-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const lines = $$('.preorder-edit-line', form).map((row) => ({
        productId: row.querySelector('[name="productId"]').value,
        quantity: Number(row.querySelector('[name="quantity"]').value),
      }));
      if (lines.some((line) => !line.productId || !Number.isFinite(line.quantity) || line.quantity <= 0)) {
        return notice('Selecciona un producto y una cantidad válida en cada línea.', true);
      }
      try {
        const response = await apiFetch(`/api/preorders/${encodeURIComponent(form.elements.id.value)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: form.elements.clientId.value,
            operatingDate: form.elements.operatingDate.value,
            reference: form.elements.reference.value.trim(),
            lines,
          }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'No se pudo actualizar la preventa');
        resetPreorderEdit();
        await refresh();
        notice('Preventa actualizada; el inventario sigue sin descontarse hasta el despacho.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#close-sale-detail').addEventListener('click', () => $('#sale-detail').classList.add('hidden'));
    $('#client-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const id = values.id;
      const payload = {
        ...values,
        routeId: values.routeId || 'route-001',
        active: values.active === '1',
      };
      try {
        if (id) {
          const response = await apiFetch(`/api/clients/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'No se pudo actualizar el cliente');
          resetClientForm();
          await refresh();
          notice('Cliente actualizado.');
        } else {
          const result = await saveOrQueue(operation('client', payload));
          resetClientForm();
          await refresh();
          notice(result.queued ? 'Cliente guardado localmente; pendiente de sincronizar.' : 'Cliente guardado.');
        }
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#clients-body').addEventListener('click', async (event) => {
      const editButton = event.target.closest('.client-edit');
      const button = event.target.closest('.client-status');
      if (editButton) {
        const client = state.clients.find((item) => item.id === editButton.dataset.id);
        if (!client) return;
        const form = $('#client-form');
        form.elements.id.value = client.id;
        form.elements.taxId.value = client.tax_id || '';
        form.elements.fullName.value = client.full_name || '';
        form.elements.businessName.value = client.business_name || client.name || '';
        form.elements.phone.value = client.phone || '';
        form.elements.email.value = client.email || '';
        form.elements.address.value = client.address || '';
        form.elements.reference.value = client.reference || '';
        form.elements.routeId.value = client.route_id || 'route-001';
        form.elements.active.value = client.active ? '1' : '0';
        form.elements.notes.value = client.notes || '';
        form.elements.latitude.value = client.latitude ?? '';
        form.elements.longitude.value = client.longitude ?? '';
        $('#client-form-title').textContent = 'Editar ficha de cliente';
        $('#client-form button[type="submit"]').textContent = 'Guardar cambios';
        $('#client-cancel').classList.remove('hidden');
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (!button) return;
      const active = button.dataset.active !== '1';
      try {
        const response = await apiFetch(`/api/clients/${encodeURIComponent(button.dataset.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'No se pudo cambiar el estado del cliente');
        await refresh();
        notice(active ? 'Cliente activado.' : 'Cliente desactivado; su historial se conserva.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#client-cancel').addEventListener('click', resetClientForm);
    $('#capture-gps').addEventListener('click', () => {
      if (!navigator.geolocation) return notice('Este dispositivo no ofrece ubicación GPS.', true);
      $('#gps-status').textContent = 'Obteniendo ubicación…';
      navigator.geolocation.getCurrentPosition((position) => {
        $('#client-form [name="latitude"]').value = position.coords.latitude;
        $('#client-form [name="longitude"]').value = position.coords.longitude;
        $('#gps-status').textContent = `Ubicación guardada: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`;
      }, (error) => {
        $('#gps-status').textContent = `No se pudo obtener GPS: ${error.message}`;
      }, { enableHighAccuracy: true, timeout: 12000 });
    });
    $('#closing-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const closingDate = event.currentTarget.elements.closingDate.value;
      if (!confirm(`¿Cerrar el inventario del ${closingDate}? El día no aceptará operaciones posteriores.`)) return;
      try {
        const response = await apiFetch('/api/closings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ closingDate }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'No se pudo cerrar el día');
        await refresh();
        notice(body.duplicate ? 'Ese día ya estaba cerrado.' : 'Cierre diario guardado.');
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#rotation-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const from = event.currentTarget.elements.from.value;
      const to = event.currentTarget.elements.to.value;
      try {
        state.rotation = await getData(`/api/reports/rotation?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
        renderRotation(state.rotation);
        $('#rotation-export').href = `/api/export?resource=rotation&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      } catch (error) {
        notice(error.message, true);
      }
    });
    $('#rotation-form').requestSubmit();
    $('#closings-body').addEventListener('click', async (event) => {
      const button = event.target.closest('.view-closing');
      if (!button) return;
      const date = button.dataset.date;
      try {
        const details = await getData(`/api/closing-details?date=${encodeURIComponent(date)}`);
        $('#closing-detail-body').innerHTML = details.map((row) => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td>
          <td>${Number(row.opening_stock)}</td><td>${Number(row.entries)}</td><td>${Number(row.exits)}</td><td>${Number(row.sales)}</td>
          <td>${Number(row.adjustments)}</td><td>${Number(row.returns)}</td><td class="stock-value">${Number(row.closing_stock)}</td></tr>`).join('');
        $('#closing-export').href = `/api/export?resource=closing&date=${encodeURIComponent(date)}`;
        $('#closing-detail').classList.remove('hidden');
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  if (sellerMode) {
    $('#seller-form [name="operatingDate"]').value = dateToday();
    $('#add-sale-line').addEventListener('click', addSaleLine);
    $('#sale-lines').addEventListener('click', (event) => {
      if (event.target.closest('.remove-line')) {
        if ($$('.sale-line').length > 1) event.target.closest('.sale-line').remove();
        else notice('La operación debe incluir al menos un producto.', true);
        renderSaleSummary();
      }
    });
    $('#sale-lines').addEventListener('input', renderSaleSummary);
    $('#sale-lines').addEventListener('change', renderSaleSummary);
    $('#seller-form').addEventListener('change', (event) => {
      if (event.target.matches('[name="kind"]')) renderSaleSummary();
    });
    $('#new-client-toggle').addEventListener('click', () => $('#seller-new-client').classList.toggle('hidden'));
    $('#save-inline-client').addEventListener('click', saveInlineClient);
    $('#seller-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submitButton = form.querySelector('[type="submit"]');
      if (submitButton.disabled) return;
      const lines = $$('.sale-line', form).map((line) => ({
        productId: $('select', line).value, quantity: Number($('input', line).value),
      }));
      if (lines.some((line) => !line.productId || !Number.isFinite(line.quantity) || line.quantity <= 0)) {
        return notice('Selecciona un producto y una cantidad válida en cada línea.', true);
      }
      const payload = {
        clientId: form.elements.clientId.value,
        kind: form.elements.kind.value,
        operatingDate: form.elements.operatingDate.value,
        occurredAt: new Date().toISOString(),
        reference: form.elements.reference.value.trim(),
        lines: lines.map((line) => ({
          ...line,
          unitPrice: Number(state.products.find((product) => product.id === line.productId)?.price ?? 0),
          priceVersion: state.products.find((product) => product.id === line.productId)?.price_version,
        })),
      };
      if (!payload.clientId) return notice('Selecciona un cliente.', true);
      submitButton.disabled = true;
      try {
        const result = await saveOrQueue(operation('sale', payload));
        form.reset();
        if (currentUser.role === 'PREVENTA') $('#seller-form input[value="PREVENTA"]').checked = true;
        form.elements.operatingDate.value = dateToday();
        $('#sale-lines').innerHTML = '';
        addSaleLine();
        notice(result.queued
          ? 'Operación guardada en el teléfono; se enviará cuando vuelva la conexión.'
          : payload.kind === 'PREVENTA' ? 'Preventa guardada; aún no se descontó inventario.' : 'Autoventa guardada e inventario actualizado.');
        await refresh();
      } catch (error) {
        notice(error.message, true);
      } finally {
        submitButton.disabled = false;
      }
    });
    addSaleLine();
  }

  $('#sync-now')?.addEventListener('click', syncQueue);
  $('#sync-seller')?.addEventListener('click', syncQueue);
  window.addEventListener('online', syncQueue);
  window.addEventListener('offline', () => setConnection(false));
  window.addEventListener('focus', syncQueue);
  setConnection(navigator.onLine && !offlineSession);
  await refresh();
  if (currentUser.role === 'ADMIN') await refreshSecurity();
  if (!offlineSession) await syncQueue();
}

initialize().catch((error) => {
  console.error('No se pudo inicializar DRESA:', error);
  setConnection(false);
  notice(`Error al iniciar la aplicación: ${error.message}`, true);
});
