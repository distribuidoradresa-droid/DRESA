# DRESA

Plataforma local para catálogo, inventario, clientes, autoventas, preventas y cierres diarios. La matriz y la aplicación móvil usan el mismo servidor y la misma base de datos SQLite; no requiere pasarelas de pago, facturación electrónica ni servicios de nube.

## Requisitos e inicio

- Node.js 22.5 o posterior.
- En la carpeta del proyecto: `npm start`.
- En la computadora matriz: abrir `http://localhost:3000`.
- La vista para el vendedor está en `/vendedor`.
- Los datos persistentes se guardan en `data/dresa.sqlite`. Conserva una copia de ese archivo para respaldar los datos; SQLite también puede crear archivos WAL mientras el servidor esté activo.

El servidor escucha solo en `127.0.0.1` por defecto. Para habilitar el acceso desde celulares de una red local de confianza, fija una dirección IP en la computadora matriz y configura `DRESA_HOST=0.0.0.0` antes de iniciarlo. En PowerShell:

```powershell
$env:DRESA_HOST = "0.0.0.0"
npm start
```

Permite ese puerto únicamente en el firewall para la red local de DRESA. El servidor no implementa cuentas administrativas del sistema operativo: mantenlo dentro de la red local de DRESA y no lo publiques en Internet ni en una red abierta.

## Usuarios y acceso

- En el primer arranque sin usuarios, la consola muestra un token aleatorio de configuración inicial. Ábrelo desde la matriz, introduce el token y crea la cuenta ADMIN. El token solo sirve hasta que se crea esa primera cuenta y no se guarda en la base de datos.
- Crea cuentas desde **Usuarios y dispositivos**. Los usuarios deben tener entre 3 y 40 caracteres (letras, números, punto, guion o guion bajo); las contraseñas requieren al menos 12 caracteres.
- Las contraseñas se almacenan como derivaciones `scrypt` con sal aleatoria; no se guardan en texto plano. Las sesiones usan tokens aleatorios almacenados como hashes, cookies `HttpOnly`, `Secure` y `SameSite=Strict`, vencen a los 7 días y se vinculan al identificador del dispositivo. Las solicitudes de escritura validan además origen y token CSRF.
- Solo puede existir una sesión activa por usuario. Desactivar una cuenta, cambiarle el rol, restablecer su contraseña, bloquear/revocar su dispositivo o revocar su sesión invalida el acceso al servidor.
- La matriz no puede cambiar su propio rol, alcance de ruta o estado; estas restricciones también se validan en el servidor. Los usuarios de ruta sin ruta y bodega activas no pueden iniciar sesión.
- La sección de usuarios muestra un historial append-only de accesos y acciones administrativas sobre cuentas, rutas, bodegas, dispositivos y sesiones. No registra contraseñas, hashes ni tokens.
- ADMIN / MATRIZ puede administrar la plataforma. VENDEDOR puede consultar productos/clientes y registrar operaciones de ruta. PREVENTA no puede registrar autoventas. Los permisos se verifican en el servidor, no solo en la interfaz.
- Administra las bodegas y rutas en **Rutas y bodegas** antes de crear usuarios de ruta: registra la bodega real, asígnala a una ruta activa y luego asigna esa ruta a cada VENDEDOR/PREVENTA. La instalación incluye Ruta 001 sin bodega para que la matriz la configure; no se crean bodegas ficticias.
- La matriz puede crear y editar rutas y bodegas, pero no borrarlas. Una ruta no se puede desactivar mientras tenga vendedores o clientes activos; una bodega no se puede desactivar mientras esté vinculada a una ruta activa.
- VENDEDOR y PREVENTA solo reciben clientes activos de su ruta. La ruta del usuario se valida también al crear clientes y ventas sincronizadas; cambiar la ruta revoca sus sesiones para que vuelva a iniciar sesión con el alcance actualizado.
- Cada ruta activa está vinculada a una bodega activa; las ventas y despachos de sus clientes descuentan únicamente el stock de esa bodega. La matriz puede consultar el total, una bodega o el saldo histórico que aún no tenga bodega asignada. Al registrar la primera bodega activa en una instalación heredada, los movimientos existentes sin bodega se atribuyen a ella para conservar el saldo operativo unificado; comprueba que sea la bodega correcta antes de operar.
- El primer inicio de sesión de una cuenta desde un dispositivo nuevo crea una solicitud pendiente. Autorízala desde **Usuarios y dispositivos**; esa acción puede revocar el dispositivo autorizado anteriormente. Un dispositivo bloqueado debe autorizarse de nuevo desde la matriz.
- DRESA debe servirse por HTTPS para el acceso móvil, ya que las cookies de sesión son `Secure`. Usa un certificado de confianza instalado en los celulares según la sección de HTTPS anterior y limita el firewall a la red local de DRESA.

## Uso offline en celulares

La aplicación conserva en IndexedDB los clientes, ventas y preventas pendientes asociados a la cuenta que los registró. Las respuestas de API guardadas para uso offline se separan por usuario, rol y ruta; al cerrar sesión se borran esas cachés, sin borrar la cola de operaciones pendiente. Tras autenticarte en un dispositivo autorizado, puede seguir trabajando sin conexión mientras la sesión local siga vigente (hasta 7 días). Al recuperar la red, vuelve a validar la sesión y reintenta la sincronización en orden de creación; cada operación conserva su UUID y el servidor la aplica de forma transaccional e idempotente. Los conflictos quedan en el teléfono y se registran también en la matriz con el usuario, operación, error e intentos; una operación exitosa al reintentarse elimina ese conflicto.

La matriz no puede revocar de inmediato una sesión en un teléfono que está desconectado: el servidor aplica la revocación cuando el teléfono vuelve a conectarse. Protege también el acceso físico al teléfono y no compartas la cuenta del vendedor.

Para que el navegador permita instalar la PWA y abrirla offline después de cerrar el navegador, sirve el sitio por HTTPS con un certificado de una autoridad de confianza instalada en los dispositivos. El servidor puede usar un certificado/certificado privado ya preparado mediante las variables `DRESA_TLS_CERT` y `DRESA_TLS_KEY`; ambas son obligatorias juntas. `mkcert` es una opción gratuita para crear una autoridad local. Instala y confía su certificado raíz en cada celular, crea el certificado del servidor con la IP fija de la matriz en sus nombres alternativos (SAN), y luego configura, por ejemplo:

```powershell
$env:DRESA_HOST = "0.0.0.0"
$env:DRESA_TLS_CERT = "C:\ruta\local\dresa-cert.pem"
$env:DRESA_TLS_KEY = "C:\ruta\local\dresa-key.pem"
npm start
```

Con HTTPS, abre `https://<IP-de-la-matriz>:3000/vendedor` en cada celular e instala la aplicación desde las opciones del navegador. El modo offline mantiene una copia local por dispositivo; una autoventa que ya no tenga stock al sincronizar se conserva como conflicto y no se registra en el servidor. Las preventas no afectan existencias hasta su despacho desde la matriz.

## Operaciones e inventario

- El stock es la suma del libro inmutable de movimientos: aperturas, entradas, salidas, ventas, ajustes y devoluciones.
- Cada movimiento nuevo queda asociado a su bodega; las entradas, salidas y ajustes de matriz requieren seleccionar bodega cuando hay más de una activa. La existencia total sigue disponible como suma de todas las bodegas.
- Una autoventa descuenta stock en la misma transacción que registra sus líneas.
- La venta conserva la hora y la versión de precio que el celular tenía autorizada al registrar la operación. Una venta offline previa a un cambio de precio conserva esa cotización al sincronizar; no se acepta un precio histórico inventado o una cotización usada fuera de su vigencia.
- Antes de actualizar desde la versión 17, sincroniza las operaciones pendientes. Esas ventas no incluyen una versión de precio verificable; si el precio cambió mientras el teléfono estuvo offline, se conservarán pendientes para revisión en lugar de aceptar un precio histórico no verificable.
- Una preventa crea un pedido pendiente sin cambiar el stock. La matriz puede corregir cliente, fecha, referencia y productos mientras siga pendiente; los productos añadidos toman el precio vigente y las líneas existentes conservan su precio acordado. Al despacharla, el servidor valida nuevamente el stock y registra los movimientos en una sola transacción. Una preventa pendiente también se puede cancelar.
- El servidor vuelve a validar el stock en la transacción de cada autoventa y despacho. Si dos vendedores compiten por las últimas unidades, solo se acepta la operación que todavía cabe en el inventario; el conflicto restante sigue visible en las operaciones pendientes del dispositivo.
- El servidor impide stock negativo, fechas futuras y operaciones con fecha de un cierre ya registrado.
- El cierre conserva una fotografía por producto: inventario anterior, entradas, salidas, ventas, ajustes, devoluciones e inventario actual, incluyendo productos sin movimiento.
- Desactivar un cliente lo oculta de la lista de ruta sin borrar el cliente ni sus ventas anteriores. La matriz puede volver a activarlo.
- La ficha de cliente conserva RUC/cédula, nombre completo, negocio, contacto, correo, dirección, referencia, ruta, estado y observaciones. La matriz puede crear, editar, consultar y desactivar clientes; cada vendedor consulta y registra clientes únicamente para su ruta asignada.
- Las ventas, movimientos, clientes y cierres nuevos guardan el usuario que los registró; los despachos guardan además quién y cuándo los confirmó. Los registros anteriores a esta ampliación aparecen como anteriores a la auditoría.
- Los botones de exportación descargan CSV compatible con Excel.
- **Rotación y actividad** incluye un reporte de ventas filtrable por fecha, vendedor, ruta, cliente y producto, con exportación CSV. La lista matricial de clientes puede buscar por identificación, nombres, negocio, contacto, dirección, referencia o ruta.

## Pruebas

`npm test` ejecuta las pruebas de API y reglas de inventario en una base SQLite temporal en memoria.
