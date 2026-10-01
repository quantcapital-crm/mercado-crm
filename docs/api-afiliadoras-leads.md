# API de carga de clientes por afiliadoras

La integración inbound está en un único endpoint de servidor TanStack Start, pensado para **Trackbox** (no hay otra ruta API equivalente para afiliadoras).

---

## 1. Ubicación del código

| Archivo | Rol |
|---------|-----|
| `src/routes/api/v1/leads.ts` | **Endpoint principal** — handlers `POST` y `GET` |
| `src/lib/client-import.ts` | Sanitización (`sanitizeDbClientRow`, normalización de teléfono/email) |
| `src/utils/supabaseAdmin.ts` | Cliente Supabase con `service_role` (bypass RLS) |
| `test-lead.json` | Ejemplo de payload de prueba |

**Ruta expuesta:** `POST/GET /api/v1/leads`

> **Nota:** `supabase/functions/create-affiliate/` crea cuentas de afiliadora en el CRM (UI admin), **no** carga clientes vía API.

---

## 2. Flujo de la petición

### Autenticación (`checkAuth`, líneas 180–201)

Requiere **las tres** credenciales a la vez:

| Header | Variable de entorno |
|--------|---------------------|
| `x-trackbox-username` | `TRACKBOX_INBOUND_USER` |
| `x-trackbox-password` | `TRACKBOX_INBOUND_PASSWORD` |
| `Authorization: Bearer <token>` | `TRACKBOX_INBOUND_TOKEN` |

Si alguna falla → `401 Unauthorized`.

---

### `POST` — Crear lead(s)

**Body JSON:**

| Campo | Requerido | Notas |
|-------|-----------|-------|
| `first_name` | Sí | string no vacío |
| `last_name` | Sí | string no vacío |
| `phone` | Sí | string no vacío |
| `email` | Sí | string no vacío |
| `country` | Sí | string no vacío |
| `tp_account` | No | Se parsea pero **se ignora**; siempre se auto-genera (8 dígitos, 10000000–99999999) |

**Modos:**

- **Objeto único** → inserta 1 cliente
- **Array** → carga masiva (chunks de 200)

**Validaciones:**

- JSON inválido → `400`
- Campos faltantes → `400`
- Duplicado por teléfono o email:
  - Single → `409` con `conflict_field: "phone" | "email"`
  - Bulk → se omite y cuenta en `skipped_duplicates`

**Respuestas:**

- Single exitoso → `201` + registro del cliente
- Bulk exitoso → `200` + `{ processed, inserted, skipped_duplicates }`

---

### `GET` — Consultar lead(s)

**Query params (búsqueda puntual — uno o más):**

- `email`, `phone`, `tp_account` → devuelve `{ client, history }` o `404`

**Query params (reporte):**

- `start_date`, `end_date` (YYYY-MM-DD o ISO), `lead_status`
- Sin filtros → últimos 100 clientes por `created_on`

---

## 3. Asignación de la afiliadora (Diamond)

Hardcodeado en constantes (`src/routes/api/v1/leads.ts`, líneas 23–27):

```ts
/** Nombre del afiliado en `clients.affiliate` (columna texto, no UUID). */
const DIAMOND_AFFILIATE_NAME = "Diamond";

/** UUID del asesor Diamond en `clients.owner_id` → `profiles.id`. */
const DIAMOND_OWNER_ID = "061d974b-b5ac-466d-abbd-36087e3c3d00";
```

Se inyecta justo antes del insert mediante `withDiamondAssignment` (líneas 279–289):

```ts
function withDiamondAssignment(row) {
  return {
    ...row,
    affiliate: DIAMOND_AFFILIATE_NAME,
    owner_id: DIAMOND_OWNER_ID,
  };
}
```

**Dónde se usa:**

- Insert single: línea **514** (`processSingleLead`)
- Insert bulk: línea **419** (`insertClientsBulk`)

El payload entrante **no puede elegir** afiliadora ni asesor; `toClientPayload` los deja en `null` y Diamond se fuerza al insertar.

**No se crean citas** (`appointments` no se toca en este endpoint).

---

## 4. Inserción en BD

### Tabla `clients` — **INSERT**

Campos escritos en el insert:

| Campo | Valor |
|-------|-------|
| `first_name`, `last_name`, `phone`, `email`, `country` | Del payload (sanitizados) |
| `tp_account` | Auto-generado único |
| `lead_status` | `"New"` |
| `affiliate` | `"Diamond"` (hardcoded) |
| `owner_id` | `"061d974b-b5ac-466d-abbd-36087e3c3d00"` (hardcoded) |

No hay UPDATE en duplicados; solo skip o error 409.

---

### Tabla `activity_logs` — **INSERT**

Tras cada insert exitoso se crea un comentario:

| Campo | Valor |
|-------|-------|
| `client_phone` | Teléfono del cliente |
| `agent_id` | `TRACKBOX_SYSTEM_AGENT_ID` (env) o primer perfil `Admin` en `profiles` |
| `text` | `"Lead ingresado automáticamente vía API Trackbox"` |
| `type` | `"comment"` |

---

### Tabla `profiles` — **solo lectura**

Usada en `resolveSystemAgentId()` para obtener el `agent_id` del log de actividad.

---

### Tablas que **no** se usan

- `appointments`
- `leads` (no existe)
- `affiliates` (la afiliadora va como texto en `clients.affiliate`, no como FK)

---

## Diagrama resumido

```
POST /api/v1/leads
  → checkAuth (3 headers)
  → parse body (single | array)
  → dedup por phone/email
  → generate tp_account
  → withDiamondAssignment()  ← affiliate="Diamond", owner_id=UUID
  → INSERT clients
  → INSERT activity_logs
```

---

## Puntos clave para refactorizar

1. **Afiliadora fija**: toda la API asume Diamond; no hay multi-tenant por afiliadora.
2. **`tp_account` del body se ignora** aunque se acepte en el parser.
3. **Auth acoplada a Trackbox** — nombres de headers y env vars específicos.
4. **Service role** en servidor — la API no usa RLS del cliente anon.
5. **Sin citas** — solo clientes + log de actividad.
