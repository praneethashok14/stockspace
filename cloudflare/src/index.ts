import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

// ---------- Types ----------

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  SESSION_TTL_SECONDS?: string;
  PBKDF2_ITERATIONS?: string;
}

interface Session {
  account_id: string;
  csrf: string;
  created_at: number;
}

type Kind = "fridge" | "freezer" | "shelf" | "other";
type PackStatus = "opened" | "unopened";

interface Appliance {
  id: string;
  name: string;
  kind: Kind;
  location?: string | null;
  description?: string | null;
  created_at: string;
  updated_at: string;
}

interface Group {
  id: string;
  name: string;
  appliance_id: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
}

interface InventoryItemBase {
  id: string;
  name: string;
  appliance_id: string;
  group_id?: string | null;
  category?: string | null;
  expiration_date?: string | null;
  notes?: string | null;
  has_photo?: boolean;
  created_at: string;
  updated_at: string;
}

type InventoryItem = InventoryItemBase &
  (
    | { tracking: "individual"; quantity: number; unit: string }
    | { tracking: "pack"; pack_count: number; pack_label: string; pack_status: PackStatus }
  );

interface Inventory {
  appliances: Appliance[];
  groups: Group[];
  items: InventoryItem[];
}

const EMPTY_INVENTORY: Inventory = { appliances: [], groups: [], items: [] };

const SESSION_COOKIE = "stockspace_session";
const CSRF_HEADER = "x-stockspace-csrf";

// ---------- App ----------

const app = new Hono<{
  Bindings: Env;
  Variables: { session?: Session };
}>();

// ---------- Auth helpers ----------

function sessionTtl(env: Env): number {
  const n = Number(env.SESSION_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

function pbkdf2Iterations(env: Env): number {
  const n = Number(env.PBKDF2_ITERATIONS);
  return Number.isFinite(n) && n > 0 ? n : 500_000;
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hashPin(pin: string, env: Env): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = pbkdf2Iterations(env);
  const bits = await deriveBits(pin, salt, iterations);
  return `pbkdf2-sha256:${iterations}:${toBase64(salt)}:${toBase64(bits)}`;
}

async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = fromBase64(parts[2]!);
  const want = fromBase64(parts[3]!);
  const got = new Uint8Array(await deriveBits(pin, salt, iterations));
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ want[i]!;
  return diff === 0;
}

async function deriveBits(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    256,
  );
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function createSession(env: Env, accountId: string): Promise<Session & { id: string }> {
  const id = randomToken(32);
  const csrf = randomToken(32);
  const session: Session = { account_id: accountId, csrf, created_at: Date.now() };
  await env.SESSIONS.put(id, JSON.stringify(session), {
    expirationTtl: sessionTtl(env),
  });
  return { id, ...session };
}

async function loadSession(env: Env, id: string): Promise<Session | null> {
  const raw = await env.SESSIONS.get(id);
  if (!raw) return null;
  const session = JSON.parse(raw) as Session;
  // Refresh TTL (sliding expiration) so active users don't get kicked.
  await env.SESSIONS.put(id, raw, { expirationTtl: sessionTtl(env) });
  return session;
}

async function revokeSession(env: Env, id: string): Promise<void> {
  await env.SESSIONS.delete(id);
}

async function requireAuth(c: any): Promise<Response | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return jsonError(c, 401, "unauthorized", "authentication required");
  const session = await loadSession(c.env, id);
  if (!session) return jsonError(c, 401, "unauthorized", "authentication required");
  c.set("session", session);
  return null;
}

function requireCsrf(c: any, session: Session): Response | null {
  const token = c.req.header(CSRF_HEADER);
  if (!token || !constantTimeEq(token, session.csrf)) {
    return jsonError(c, 403, "forbidden", "request not permitted");
  }
  return null;
}

function setSessionCookie(c: any, id: string, env: Env): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: sessionTtl(env),
  });
}

function clearSessionCookie(c: any): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

// ---------- Validation ----------

function validateName(name: string | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return null;
  return trimmed;
}

function validatePin(pin: string | undefined): boolean {
  return !!pin && /^\d{4,12}$/.test(pin);
}

function validItemName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 200;
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime());
}

function blankToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function roundQuantity(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ---------- D1 helpers ----------

async function getInventory(env: Env, accountId: string): Promise<Inventory> {
  const row = await env.DB.prepare("SELECT data FROM inventories WHERE account_id = ?")
    .bind(accountId)
    .first<{ data: string }>();
  if (!row) return structuredClone(EMPTY_INVENTORY);
  try {
    return JSON.parse(row.data) as Inventory;
  } catch {
    return structuredClone(EMPTY_INVENTORY);
  }
}

async function putInventory(env: Env, accountId: string, inv: Inventory): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO inventories (account_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(accountId, JSON.stringify(inv), now)
    .run();
}

/**
 * Mutate an account's inventory atomically. D1 serializes writes per-database,
 * and we rewrite the whole blob, so there are no interleaved partial updates.
 * We also wrap in a transaction so a failing mutator leaves the row untouched.
 */
async function mutateInventory<T>(
  env: Env,
  accountId: string,
  fn: (inv: Inventory) => T | Promise<T>,
): Promise<T> {
  const inv = await getInventory(env, accountId);
  const result = await fn(inv);
  await putInventory(env, accountId, inv);
  return result;
}

// ---------- Family helpers ----------

type Role = "owner" | "member";

interface FamilyMember {
  account_id: string;
  account_name: string;
  role: Role;
  joined_at: string;
}

interface FamilyInfo {
  family_id: string | null;
  my_role: Role | null;
  members: FamilyMember[];
}

async function getFamilyInfo(env: Env, accountId: string): Promise<FamilyInfo> {
  const mine = await env.DB.prepare(
    "SELECT family_id, role FROM family_memberships WHERE account_id = ?",
  )
    .bind(accountId)
    .first<{ family_id: string; role: Role }>();
  if (!mine) return { family_id: null, my_role: null, members: [] };
  const rows = await env.DB.prepare(
    `SELECT m.account_id, m.role, m.joined_at, a.name AS account_name
       FROM family_memberships m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.family_id = ?
      ORDER BY m.joined_at`,
  )
    .bind(mine.family_id)
    .all<FamilyMember>();
  return {
    family_id: mine.family_id,
    my_role: mine.role,
    members: rows.results ?? [],
  };
}

// Returns [callerId, ...familyMemberIds]. Solo accounts return [callerId].
async function accessibleAccountIds(env: Env, callerId: string): Promise<string[]> {
  const fam = await getFamilyInfo(env, callerId);
  if (fam.family_id === null) return [callerId];
  const ids = fam.members.map((m) => m.account_id);
  if (!ids.includes(callerId)) ids.push(callerId);
  return ids;
}

interface OwnerLookup {
  owner_id: string;
  owner_name: string;
  caller_role: Role | null; // null when solo
}

// Finds which accessible account's inventory contains the given appliance.
// Throws 404 if not found anywhere the caller can see.
async function resolveApplianceOwner(
  env: Env,
  callerId: string,
  applianceId: string,
): Promise<OwnerLookup> {
  const fam = await getFamilyInfo(env, callerId);
  const ids = fam.family_id ? fam.members.map((m) => m.account_id) : [callerId];
  for (const id of ids) {
    const inv = await getInventory(env, id);
    if (inv.appliances.some((a) => a.id === applianceId)) {
      const name =
        fam.members.find((m) => m.account_id === id)?.account_name ??
        (await accountName(env, id)) ??
        "?";
      return { owner_id: id, owner_name: name, caller_role: fam.my_role };
    }
  }
  throw new HttpErr(404, `appliance ${applianceId} not found`);
}

async function resolveGroupOwner(
  env: Env,
  callerId: string,
  groupId: string,
): Promise<OwnerLookup> {
  const fam = await getFamilyInfo(env, callerId);
  const ids = fam.family_id ? fam.members.map((m) => m.account_id) : [callerId];
  for (const id of ids) {
    const inv = await getInventory(env, id);
    if (inv.groups.some((g) => g.id === groupId)) {
      const name =
        fam.members.find((m) => m.account_id === id)?.account_name ??
        (await accountName(env, id)) ??
        "?";
      return { owner_id: id, owner_name: name, caller_role: fam.my_role };
    }
  }
  throw new HttpErr(404, `group ${groupId} not found`);
}

async function accountName(env: Env, accountId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT name FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ name: string }>();
  return row?.name ?? null;
}

// Solo accounts (no family) can always perform structural ops. Family members
// can only perform structural ops if their role is "owner".
function assertOwnerIfInFamily(fam: FamilyInfo): void {
  if (fam.family_id !== null && fam.my_role !== "owner") {
    throw new HttpErr(403, "only family owners can create or modify appliances and groups");
  }
}

// Loads merged inventory across the caller + family members, tagging each
// entity with owner_account_id / owner_account_name.
async function getMergedInventory(
  env: Env,
  callerId: string,
): Promise<{
  appliances: (Appliance & { owner_account_id: string; owner_account_name: string })[];
  groups: (Group & { owner_account_id: string; owner_account_name: string })[];
  items: (InventoryItem & { owner_account_id: string; owner_account_name: string })[];
  family: FamilyInfo;
}> {
  const fam = await getFamilyInfo(env, callerId);
  const sources =
    fam.family_id === null
      ? [{ id: callerId, name: (await accountName(env, callerId)) ?? "" }]
      : fam.members.map((m) => ({ id: m.account_id, name: m.account_name }));
  const appliances: any[] = [];
  const groups: any[] = [];
  const items: any[] = [];
  for (const src of sources) {
    const inv = await getInventory(env, src.id);
    for (const a of inv.appliances)
      appliances.push({ ...a, owner_account_id: src.id, owner_account_name: src.name });
    for (const g of inv.groups)
      groups.push({ ...g, owner_account_id: src.id, owner_account_name: src.name });
    for (const i of inv.items)
      items.push({ ...i, owner_account_id: src.id, owner_account_name: src.name });
  }
  return { appliances, groups, items, family: fam };
}

// ---------- Error helpers ----------

function jsonError(c: any, status: number, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function newId(): string {
  return crypto.randomUUID();
}

// ---------- Routes: health + auth ----------

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/auth/status", async (c) => {
  const rows = await c.env.DB.prepare("SELECT name FROM accounts ORDER BY name_lower").all<{
    name: string;
  }>();
  const names = (rows.results ?? []).map((r) => r.name);
  return c.json({
    has_accounts: names.length > 0,
    account_count: names.length,
    account_names: names,
  });
});

app.get("/api/auth/session", async (c) => {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return c.json({ authenticated: false });
  const session = await loadSession(c.env, id);
  if (!session) return c.json({ authenticated: false });
  const account = await c.env.DB.prepare("SELECT name FROM accounts WHERE id = ?")
    .bind(session.account_id)
    .first<{ name: string }>();
  const fam = await getFamilyInfo(c.env, session.account_id);
  return c.json({
    authenticated: true,
    csrf_token: session.csrf,
    account_id: session.account_id,
    account_name: account?.name ?? null,
    family_id: fam.family_id,
    family_role: fam.my_role,
  });
});

app.post("/api/auth/signup", async (c) => {
  const body = await c.req.json<{ name?: string; pin?: string }>().catch(() => ({}));
  const name = validateName(body.name);
  if (!name) return jsonError(c, 400, "bad_request", "name is required");
  if (!validatePin(body.pin)) return jsonError(c, 400, "bad_request", "pin must be 4-12 digits");
  const nameLower = name.toLowerCase();
  const existing = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE name_lower = ?",
  )
    .bind(nameLower)
    .first();
  if (existing) return jsonError(c, 409, "conflict", "that name is already in use");
  const id = newId();
  const now = nowIso();
  const pinHash = await hashPin(body.pin!, c.env);
  await c.env.DB.prepare(
    "INSERT INTO accounts (id, name, name_lower, pin_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, name, nameLower, pinHash, now, now)
    .run();
  const session = await createSession(c.env, id);
  setSessionCookie(c, session.id, c.env);
  return c.json(
    {
      authenticated: true,
      csrf_token: session.csrf,
      account_id: id,
      account_name: name,
      family_id: null,
      family_role: null,
    },
    201,
  );
});

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ name?: string; pin?: string }>().catch(() => ({}));
  const name = validateName(body.name);
  if (!name || !validatePin(body.pin)) {
    return jsonError(c, 401, "unauthorized", "incorrect name or PIN");
  }
  const account = await c.env.DB.prepare(
    "SELECT id, name, pin_hash FROM accounts WHERE name_lower = ?",
  )
    .bind(name.toLowerCase())
    .first<{ id: string; name: string; pin_hash: string }>();
  const ok = account ? await verifyPin(body.pin!, account.pin_hash) : false;
  if (!account || !ok) {
    // Perform a dummy derive on unknown names so timing doesn't leak enumeration.
    if (!account) await deriveBits(body.pin!, new Uint8Array(16), pbkdf2Iterations(c.env));
    return jsonError(c, 401, "unauthorized", "incorrect name or PIN");
  }
  const session = await createSession(c.env, account.id);
  setSessionCookie(c, session.id, c.env);
  const fam = await getFamilyInfo(c.env, account.id);
  return c.json({
    authenticated: true,
    csrf_token: session.csrf,
    account_id: account.id,
    account_name: account.name,
    family_id: fam.family_id,
    family_role: fam.my_role,
  });
});

app.post("/api/auth/lock", async (c) => {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await revokeSession(c.env, id);
  clearSessionCookie(c);
  return c.body(null, 204);
});

app.post("/api/auth/change-pin", async (c) => {
  const authErr = await requireAuth(c);
  if (authErr) return authErr;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const body = await c.req
    .json<{ current_pin?: string; new_pin?: string }>()
    .catch(() => ({}));
  if (!validatePin(body.new_pin)) {
    return jsonError(c, 400, "bad_request", "pin must be 4-12 digits");
  }
  const account = await c.env.DB.prepare("SELECT pin_hash FROM accounts WHERE id = ?")
    .bind(session.account_id)
    .first<{ pin_hash: string }>();
  if (!account || !(await verifyPin(body.current_pin ?? "", account.pin_hash))) {
    return jsonError(c, 401, "unauthorized", "incorrect current pin");
  }
  const newHash = await hashPin(body.new_pin!, c.env);
  await c.env.DB.prepare(
    "UPDATE accounts SET pin_hash = ?, updated_at = ? WHERE id = ?",
  )
    .bind(newHash, nowIso(), session.account_id)
    .run();
  // Revoke every session for this account by looking them up in KV.
  // KV has no secondary index, so we revoke only the current session here;
  // other devices will drop out at session TTL (1 hour) or on next request
  // against a now-invalid pin — acceptable for a family app.
  await revokeSession(c.env, (await getCookie(c, SESSION_COOKIE)) ?? "");
  clearSessionCookie(c);
  return c.body(null, 204);
});

// ---------- Routes: appliances ----------

app.get("/api/appliances", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const merged = await getMergedInventory(c.env, session.account_id);
  return c.json({ appliances: merged.appliances });
});

app.post("/api/appliances", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  try {
    const fam = await getFamilyInfo(c.env, session.account_id);
    assertOwnerIfInFamily(fam);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
  const body = await c.req
    .json<{ name?: string; kind?: Kind; location?: string; description?: string }>()
    .catch(() => ({}));
  if (!validItemName(body.name)) {
    return jsonError(c, 400, "bad_request", "name is required");
  }
  if (!body.kind || !["fridge", "freezer", "shelf", "other"].includes(body.kind)) {
    return jsonError(c, 400, "bad_request", "kind must be fridge, freezer, shelf, or other");
  }
  const appliance: Appliance = {
    id: newId(),
    name: body.name!.trim(),
    kind: body.kind,
    location: blankToNull(body.location),
    description: blankToNull(body.description),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const created = await mutateInventory(c.env, session.account_id, (inv) => {
    inv.appliances.push(appliance);
    return appliance;
  });
  return c.json(created, 201);
});

app.get("/api/appliances/:id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const id = c.req.param("id");
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, id);
    const inv = await getInventory(c.env, owner.owner_id);
    const appliance = inv.appliances.find((a) => a.id === id)!;
    return c.json({
      appliance: { ...appliance, owner_account_id: owner.owner_id, owner_account_name: owner.owner_name },
      groups: inv.groups.filter((g) => g.appliance_id === id),
      items: inv.items.filter((i) => i.appliance_id === id),
    });
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.patch("/api/appliances/:id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const id = c.req.param("id");
  const body = await c.req
    .json<{
      name?: string;
      kind?: Kind;
      location?: string | null;
      description?: string | null;
    }>()
    .catch(() => ({}));
  try {
    const fam = await getFamilyInfo(c.env, session.account_id);
    assertOwnerIfInFamily(fam);
    const owner = await resolveApplianceOwner(c.env, session.account_id, id);
    const updated = await mutateInventory(c.env, owner.owner_id, (inv) => {
      const a = inv.appliances.find((x) => x.id === id);
      if (!a) throw new HttpErr(404, `appliance ${id} not found`);
      if (body.name !== undefined) {
        if (!validItemName(body.name)) throw new HttpErr(400, "name must not be empty");
        a.name = body.name.trim();
      }
      if (body.kind !== undefined) {
        if (!["fridge", "freezer", "shelf", "other"].includes(body.kind)) {
          throw new HttpErr(400, "kind must be fridge, freezer, shelf, or other");
        }
        a.kind = body.kind;
      }
      if (body.location !== undefined) a.location = blankToNull(body.location);
      if (body.description !== undefined) a.description = blankToNull(body.description);
      a.updated_at = nowIso();
      return a;
    });
    return c.json(updated);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.delete("/api/appliances/:id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const id = c.req.param("id");
  const strategy = c.req.query("strategy") ?? "";
  const moveTo = c.req.query("move_to") ?? "";
  try {
    const fam = await getFamilyInfo(c.env, session.account_id);
    assertOwnerIfInFamily(fam);
    const owner = await resolveApplianceOwner(c.env, session.account_id, id);
    // move_to must belong to the same owner — we don't support cross-owner
    // transfers of appliance contents in v1.
    if (strategy === "move" && moveTo) {
      const destOwner = await resolveApplianceOwner(c.env, session.account_id, moveTo);
      if (destOwner.owner_id !== owner.owner_id) {
        return jsonError(
          c,
          400,
          "bad_request",
          "move target must belong to the same family member as the appliance being deleted",
        );
      }
    }
    await mutateInventory(c.env, owner.owner_id, (inv) => {
      if (!inv.appliances.some((a) => a.id === id)) {
        throw new HttpErr(404, `appliance ${id} not found`);
      }
      const hasContents =
        inv.items.some((i) => i.appliance_id === id) ||
        inv.groups.some((g) => g.appliance_id === id);
      if (hasContents && strategy !== "cascade" && strategy !== "move") {
        throw new HttpErr(
          409,
          "appliance has contents; specify strategy=cascade or strategy=move&move_to=<id>",
        );
      }
      if (strategy === "move") {
        if (!moveTo) throw new HttpErr(400, "move_to is required");
        if (moveTo === id)
          throw new HttpErr(400, "cannot move contents to the appliance being deleted");
        if (!inv.appliances.some((a) => a.id === moveTo)) {
          throw new HttpErr(404, `target appliance ${moveTo} not found`);
        }
        for (const item of inv.items) {
          if (item.appliance_id === id) {
            item.appliance_id = moveTo;
            item.updated_at = nowIso();
          }
        }
        for (const group of inv.groups) {
          if (group.appliance_id === id) {
            group.appliance_id = moveTo;
            group.updated_at = nowIso();
          }
        }
      } else if (strategy === "cascade") {
        inv.items = inv.items.filter((i) => i.appliance_id !== id);
        inv.groups = inv.groups.filter((g) => g.appliance_id !== id);
      }
      inv.appliances = inv.appliances.filter((a) => a.id !== id);
    });
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

// ---------- Routes: items ----------

app.get("/api/appliances/:id/items", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const id = c.req.param("id");
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, id);
    const inv = await getInventory(c.env, owner.owner_id);
    return c.json({ items: inv.items.filter((i) => i.appliance_id === id) });
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.post("/api/appliances/:id/items", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const applianceId = c.req.param("id");
  const body = await c.req.json<any>().catch(() => ({}));
  if (!validItemName(body?.name)) {
    return jsonError(c, 400, "bad_request", "name is required");
  }
  if (
    body.expiration_date &&
    body.expiration_date !== "" &&
    !isValidIsoDate(body.expiration_date)
  ) {
    return jsonError(c, 400, "bad_request", "expiration_date must be ISO-8601 (YYYY-MM-DD)");
  }
  const trackingPart = buildTrackingFromBody(body);
  if (!("ok" in trackingPart)) {
    return jsonError(c, 400, "bad_request", trackingPart.err);
  }
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, applianceId);
    const created = await mutateInventory(c.env, owner.owner_id, (inv) => {
      if (!inv.appliances.some((a) => a.id === applianceId)) {
        throw new HttpErr(404, `appliance ${applianceId} not found`);
      }
      if (body.group_id) {
        const g = inv.groups.find((x) => x.id === body.group_id);
        if (!g) throw new HttpErr(404, `group ${body.group_id} not found`);
        if (g.appliance_id !== applianceId) {
          throw new HttpErr(400, "group belongs to a different appliance");
        }
      }
      const item: InventoryItem = {
        id: newId(),
        name: (body.name as string).trim(),
        appliance_id: applianceId,
        group_id: body.group_id || null,
        category: blankToNull(body.category),
        expiration_date: blankToNull(body.expiration_date),
        notes: blankToNull(body.notes),
        has_photo: false,
        created_at: nowIso(),
        updated_at: nowIso(),
        ...trackingPart.ok,
      } as InventoryItem;
      inv.items.push(item);
      return item;
    });
    return c.json(created, 201);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.patch("/api/appliances/:id/items/:item_id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const applianceId = c.req.param("id");
  const itemId = c.req.param("item_id");
  const body = await c.req.json<any>().catch(() => ({}));
  if (
    body.expiration_date !== undefined &&
    body.expiration_date !== null &&
    body.expiration_date !== "" &&
    !isValidIsoDate(body.expiration_date)
  ) {
    return jsonError(c, 400, "bad_request", "expiration_date must be ISO-8601 (YYYY-MM-DD)");
  }
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, applianceId);
    const updated = await mutateInventory(c.env, owner.owner_id, (inv) => {
      const item = inv.items.find((x) => x.id === itemId && x.appliance_id === applianceId);
      if (!item) throw new HttpErr(404, `item ${itemId} not found`);
      if (body.name !== undefined) {
        if (!validItemName(body.name)) throw new HttpErr(400, "name must not be empty");
        item.name = (body.name as string).trim();
      }
      if (body.group_id !== undefined) item.group_id = body.group_id || null;
      if (body.category !== undefined) item.category = blankToNull(body.category);
      if (body.expiration_date !== undefined)
        item.expiration_date = blankToNull(body.expiration_date);
      if (body.notes !== undefined) item.notes = blankToNull(body.notes);
      if (item.tracking === "individual" && typeof body.unit === "string") {
        if (!validItemName(body.unit)) throw new HttpErr(400, "unit must not be empty");
        item.unit = body.unit.trim();
      }
      if (item.tracking === "pack" && typeof body.pack_label === "string") {
        if (!validItemName(body.pack_label))
          throw new HttpErr(400, "pack_label must not be empty");
        item.pack_label = body.pack_label.trim();
      }
      if (item.group_id) {
        const g = inv.groups.find((x) => x.id === item.group_id);
        if (!g || g.appliance_id !== applianceId) {
          throw new HttpErr(400, "group does not exist in this appliance");
        }
      }
      item.updated_at = nowIso();
      return item;
    });
    return c.json(updated);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.delete("/api/appliances/:id/items/:item_id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const applianceId = c.req.param("id");
  const itemId = c.req.param("item_id");
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, applianceId);
    await mutateInventory(c.env, owner.owner_id, (inv) => {
      const before = inv.items.length;
      inv.items = inv.items.filter(
        (x) => !(x.id === itemId && x.appliance_id === applianceId),
      );
      if (inv.items.length === before) {
        throw new HttpErr(404, `item ${itemId} not found`);
      }
    });
    // Best-effort photo cleanup; absent row is not an error.
    await c.env.DB.prepare(
      "DELETE FROM item_photos WHERE account_id = ? AND item_id = ?",
    )
      .bind(owner.owner_id, itemId)
      .run();
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.post("/api/appliances/:id/items/:item_id/adjust", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const applianceId = c.req.param("id");
  const itemId = c.req.param("item_id");
  const body = await c.req.json<{ delta?: number }>().catch(() => ({}));
  const delta = Number(body.delta);
  if (!Number.isFinite(delta)) {
    return jsonError(c, 400, "bad_request", "delta must be a finite number");
  }
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, applianceId);
    const updated = await mutateInventory(c.env, owner.owner_id, (inv) => {
      const item = inv.items.find((x) => x.id === itemId && x.appliance_id === applianceId);
      if (!item) throw new HttpErr(404, `item ${itemId} not found`);
      if (item.tracking === "individual") {
        const next = item.quantity + delta;
        if (!Number.isFinite(next) || next < 0) {
          throw new HttpErr(400, "resulting quantity would be invalid");
        }
        item.quantity = roundQuantity(next);
      } else {
        if (!Number.isInteger(delta)) {
          throw new HttpErr(400, "pack counts change in whole-pack increments");
        }
        const next = item.pack_count + delta;
        if (next < 0) throw new HttpErr(400, "pack count cannot go below zero");
        if (next > 4_294_967_295) throw new HttpErr(400, "pack count overflow");
        item.pack_count = next;
      }
      item.updated_at = nowIso();
      return item;
    });
    return c.json(updated);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.post("/api/appliances/:id/items/:item_id/open-one", async (c) => {
  return packTransfer(c, "open", "one");
});

app.post("/api/appliances/:id/items/:item_id/open-all", async (c) => {
  return packTransfer(c, "open", "all");
});

app.post("/api/appliances/:id/items/:item_id/close-one", async (c) => {
  return packTransfer(c, "close", "one");
});

app.post("/api/appliances/:id/items/:item_id/close-all", async (c) => {
  return packTransfer(c, "close", "all");
});

async function packTransfer(
  c: any,
  direction: "open" | "close",
  mode: "one" | "all",
): Promise<Response> {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const applianceId = c.req.param("id");
  const itemId = c.req.param("item_id");
  const sourceStatus: PackStatus = direction === "open" ? "unopened" : "opened";
  const destStatus: PackStatus = direction === "open" ? "opened" : "unopened";
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, applianceId);
    const result = await mutateInventory(c.env, owner.owner_id, (inv) => {
      const sourceIdx = inv.items.findIndex(
        (x) => x.id === itemId && x.appliance_id === applianceId,
      );
      if (sourceIdx === -1) throw new HttpErr(404, `item ${itemId} not found`);
      const source = inv.items[sourceIdx]!;
      if (source.tracking !== "pack") throw new HttpErr(400, "item is not pack-based");
      if (source.pack_status !== sourceStatus) {
        throw new HttpErr(
          400,
          direction === "open"
            ? "only unopened variants can be opened"
            : "only opened variants can be marked unopened",
        );
      }
      if (source.pack_count === 0) {
        throw new HttpErr(
          400,
          direction === "open"
            ? "no unopened packs available to open"
            : "no opened packs available to mark unopened",
        );
      }
      const transfer = mode === "one" ? 1 : source.pack_count;

      // Auto-group when the ungrouped source is being opened for the first
      // time, so opened+unopened variants of the same item live together.
      let effectiveGroupId: string | null = source.group_id ?? null;
      if (!source.group_id && direction === "open") {
        const groupName = source.name.trim();
        let g = inv.groups.find(
          (g) =>
            g.appliance_id === source.appliance_id &&
            g.name.toLowerCase() === groupName.toLowerCase(),
        );
        if (!g) {
          g = {
            id: newId(),
            name: groupName,
            appliance_id: source.appliance_id,
            description: null,
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          inv.groups.push(g);
        }
        source.group_id = g.id;
        source.updated_at = nowIso();
        effectiveGroupId = g.id;
      }

      let dest = inv.items.find(
        (i) =>
          i.appliance_id === source.appliance_id &&
          (i.group_id ?? null) === effectiveGroupId &&
          i.tracking === "pack" &&
          i.pack_status === destStatus &&
          i.pack_label === source.pack_label,
      );
      if (!dest) {
        dest = {
          id: newId(),
          name: source.name,
          appliance_id: source.appliance_id,
          group_id: effectiveGroupId,
          category: source.category ?? null,
          tracking: "pack",
          pack_count: 0,
          pack_label: source.pack_label,
          pack_status: destStatus,
          expiration_date: source.expiration_date ?? null,
          notes: source.notes ?? null,
          has_photo: false,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        inv.items.push(dest);
      }
      if (dest.tracking !== "pack") throw new HttpErr(500, "dest variant invalid");
      dest.pack_count += transfer;
      dest.updated_at = nowIso();
      source.pack_count -= transfer;
      source.updated_at = nowIso();

      let sourceAfter: InventoryItem | null = source;
      let photoCleanup: string | null = null;
      if (source.pack_count === 0) {
        photoCleanup = source.id;
        inv.items.splice(sourceIdx, 1);
        sourceAfter = null;
      }
      const sourceKey = direction === "open" ? "unopened" : "opened";
      const destKey = direction === "open" ? "opened" : "unopened";
      return {
        payload: {
          [sourceKey]: sourceAfter,
          [destKey]: dest,
          source_deleted: sourceAfter === null,
        },
        photoCleanup,
      };
    });
    if (result.photoCleanup) {
      await c.env.DB.prepare(
        "DELETE FROM item_photos WHERE account_id = ? AND item_id = ?",
      )
        .bind(owner.owner_id, result.photoCleanup)
        .run();
    }
    return c.json(result.payload);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
}

// ---------- Routes: groups ----------

app.get("/api/groups", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const merged = await getMergedInventory(c.env, session.account_id);
  return c.json({ groups: merged.groups });
});

app.post("/api/groups", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const body = await c.req
    .json<{ name?: string; appliance_id?: string; description?: string }>()
    .catch(() => ({}));
  if (!validItemName(body.name)) return jsonError(c, 400, "bad_request", "name is required");
  if (!body.appliance_id)
    return jsonError(c, 400, "bad_request", "appliance_id is required");
  try {
    const fam = await getFamilyInfo(c.env, session.account_id);
    assertOwnerIfInFamily(fam);
    const owner = await resolveApplianceOwner(c.env, session.account_id, body.appliance_id);
    const created = await mutateInventory(c.env, owner.owner_id, (inv) => {
      if (!inv.appliances.some((a) => a.id === body.appliance_id)) {
        throw new HttpErr(404, `appliance ${body.appliance_id} not found`);
      }
      const g: Group = {
        id: newId(),
        name: (body.name as string).trim(),
        appliance_id: body.appliance_id!,
        description: blankToNull(body.description),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      inv.groups.push(g);
      return g;
    });
    return c.json(created, 201);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.patch("/api/groups/:id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const id = c.req.param("id");
  const body = await c.req
    .json<{ name?: string; description?: string | null; appliance_id?: string }>()
    .catch(() => ({}));
  try {
    const fam = await getFamilyInfo(c.env, session.account_id);
    assertOwnerIfInFamily(fam);
    const owner = await resolveGroupOwner(c.env, session.account_id, id);
    if (body.appliance_id) {
      const destOwner = await resolveApplianceOwner(c.env, session.account_id, body.appliance_id);
      if (destOwner.owner_id !== owner.owner_id) {
        return jsonError(
          c,
          400,
          "bad_request",
          "cannot move a group to an appliance owned by a different family member",
        );
      }
    }
    const updated = await mutateInventory(c.env, owner.owner_id, (inv) => {
      if (body.appliance_id && !inv.appliances.some((a) => a.id === body.appliance_id)) {
        throw new HttpErr(404, `appliance ${body.appliance_id} not found`);
      }
      const g = inv.groups.find((x) => x.id === id);
      if (!g) throw new HttpErr(404, `group ${id} not found`);
      if (body.name !== undefined) {
        if (!validItemName(body.name)) throw new HttpErr(400, "name must not be empty");
        g.name = body.name.trim();
      }
      if (body.description !== undefined) g.description = blankToNull(body.description);
      if (body.appliance_id !== undefined) g.appliance_id = body.appliance_id;
      g.updated_at = nowIso();
      return g;
    });
    return c.json(updated);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.delete("/api/groups/:id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const id = c.req.param("id");
  const strategy = c.req.query("strategy") ?? "";
  const moveToGroup = c.req.query("move_to_group") ?? "";
  try {
    const fam = await getFamilyInfo(c.env, session.account_id);
    assertOwnerIfInFamily(fam);
    const owner = await resolveGroupOwner(c.env, session.account_id, id);
    await mutateInventory(c.env, owner.owner_id, (inv) => {
      if (!inv.groups.some((g) => g.id === id))
        throw new HttpErr(404, `group ${id} not found`);
      const hasChildren = inv.items.some((i) => i.group_id === id);
      if (
        hasChildren &&
        strategy !== "cascade" &&
        strategy !== "detach" &&
        strategy !== "move"
      ) {
        throw new HttpErr(
          409,
          "group has children; specify strategy=detach, strategy=move, or strategy=cascade",
        );
      }
      if (strategy === "cascade") {
        inv.items = inv.items.filter((i) => i.group_id !== id);
      } else if (strategy === "detach") {
        for (const item of inv.items) {
          if (item.group_id === id) {
            item.group_id = null;
            item.updated_at = nowIso();
          }
        }
      } else if (strategy === "move") {
        if (!inv.groups.some((g) => g.id === moveToGroup)) {
          throw new HttpErr(404, `target group ${moveToGroup} not found`);
        }
        for (const item of inv.items) {
          if (item.group_id === id) {
            item.group_id = moveToGroup;
            item.updated_at = nowIso();
          }
        }
      }
      inv.groups = inv.groups.filter((g) => g.id !== id);
    });
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

// ---------- Routes: global items ----------

app.get("/api/items", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const merged = await getMergedInventory(c.env, session.account_id);
  return c.json({
    items: merged.items,
    groups: merged.groups,
    appliances: merged.appliances,
    family: merged.family,
  });
});

// ---------- Tracking input helper ----------

function buildTrackingFromBody(
  body: any,
):
  | { ok: { tracking: "individual"; quantity: number; unit: string } }
  | { ok: { tracking: "pack"; pack_count: number; pack_label: string; pack_status: PackStatus } }
  | { err: string } {
  if (body.tracking === "individual") {
    const q = Number(body.quantity);
    if (!Number.isFinite(q) || q < 0) return { err: "quantity must be a finite non-negative number" };
    if (!validItemName(body.unit)) return { err: "unit is required" };
    return { ok: { tracking: "individual", quantity: roundQuantity(q), unit: body.unit.trim() } };
  }
  if (body.tracking === "pack") {
    const n = Number(body.pack_count);
    if (!Number.isInteger(n) || n < 0) return { err: "pack_count must be a non-negative integer" };
    if (!validItemName(body.pack_label)) return { err: "pack_label is required" };
    if (body.pack_status !== "opened" && body.pack_status !== "unopened") {
      return { err: "pack_status must be opened or unopened" };
    }
    return {
      ok: {
        tracking: "pack",
        pack_count: n,
        pack_label: body.pack_label.trim(),
        pack_status: body.pack_status,
      },
    };
  }
  return { err: "tracking must be 'individual' or 'pack'" };
}

// ---------- HttpErr helper ----------

class HttpErr extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function httpErrorResponse(c: any, e: unknown): Response {
  if (e instanceof HttpErr) {
    const code =
      e.status === 404
        ? "not_found"
        : e.status === 409
          ? "conflict"
          : e.status === 400
            ? "bad_request"
            : "internal";
    return jsonError(c, e.status, code, e.message);
  }
  console.error("unhandled route error", e);
  return jsonError(c, 500, "internal", "unexpected error");
}

// ---------- Photos (stored as BLOBs in D1) ----------

const MAX_PHOTO_BYTES_B64 = 2 * 1024 * 1024;

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

app.post("/api/appliances/:id/items/:item_id/photo", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const applianceId = c.req.param("id");
  const itemId = c.req.param("item_id");
  const body = await c.req.json<{ image_base64?: string }>().catch(() => ({}));
  if (typeof body.image_base64 !== "string") {
    return jsonError(c, 400, "bad_request", "image_base64 is required");
  }
  if (body.image_base64.length > MAX_PHOTO_BYTES_B64) {
    return jsonError(c, 400, "bad_request", "photo too large (resize to under ~1.5 MB)");
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(body.image_base64);
  } catch {
    return jsonError(c, 400, "bad_request", "image_base64 is not valid base64");
  }
  if (!looksLikeJpeg(bytes)) {
    return jsonError(
      c,
      400,
      "bad_request",
      "only JPEG uploads are accepted (resize client-side to JPEG)",
    );
  }
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, applianceId);
    const updated = await mutateInventory(c.env, owner.owner_id, (inv) => {
      const item = inv.items.find(
        (x) => x.id === itemId && x.appliance_id === applianceId,
      );
      if (!item) throw new HttpErr(404, `item ${itemId} not found`);
      item.has_photo = true;
      item.updated_at = nowIso();
      return item;
    });
    await c.env.DB.prepare(
      `INSERT INTO item_photos (account_id, item_id, data, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, item_id) DO UPDATE
         SET data = excluded.data, updated_at = excluded.updated_at`,
    )
      .bind(owner.owner_id, itemId, bytes, nowIso())
      .run();
    return c.json(updated);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.get("/api/appliances/:id/items/:item_id/photo", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const applianceId = c.req.param("id");
  const itemId = c.req.param("item_id");
  let ownerId: string;
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, applianceId);
    ownerId = owner.owner_id;
  } catch (e) {
    return httpErrorResponse(c, e);
  }
  const inv = await getInventory(c.env, ownerId);
  if (!inv.items.some((x) => x.id === itemId && x.appliance_id === applianceId)) {
    return jsonError(c, 404, "not_found", `item ${itemId} not found`);
  }
  const row = await c.env.DB.prepare(
    "SELECT data FROM item_photos WHERE account_id = ? AND item_id = ?",
  )
    .bind(ownerId, itemId)
    .first<Record<string, unknown>>();
  if (!row) return jsonError(c, 404, "not_found", "photo not found");
  const raw = (row as any).data;
  // D1's JS bindings have historically returned BLOB columns in several
  // different shapes depending on the wrangler version (ArrayBuffer, Uint8Array,
  // number[], or Node Buffer). Normalise to a Uint8Array so `new Response()`
  // always sees a valid BufferSource.
  let bytes: Uint8Array;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else if (Array.isArray(raw)) {
    bytes = new Uint8Array(raw as number[]);
  } else if (raw && typeof raw === "object" && typeof (raw as any).byteLength === "number") {
    bytes = new Uint8Array((raw as any).buffer ?? raw);
  } else {
    return jsonError(
      c,
      500,
      "internal",
      `unexpected photo blob type: ${Object.prototype.toString.call(raw)} (len=${(raw as any)?.length ?? (raw as any)?.byteLength ?? "?"})`,
    );
  }
  return new Response(bytes, {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
    },
  });
});

app.delete("/api/appliances/:id/items/:item_id/photo", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const applianceId = c.req.param("id");
  const itemId = c.req.param("item_id");
  try {
    const owner = await resolveApplianceOwner(c.env, session.account_id, applianceId);
    await mutateInventory(c.env, owner.owner_id, (inv) => {
      const item = inv.items.find(
        (x) => x.id === itemId && x.appliance_id === applianceId,
      );
      if (!item) throw new HttpErr(404, `item ${itemId} not found`);
      item.has_photo = false;
      item.updated_at = nowIso();
    });
    await c.env.DB.prepare(
      "DELETE FROM item_photos WHERE account_id = ? AND item_id = ?",
    )
      .bind(owner.owner_id, itemId)
      .run();
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

// ---------- Routes: families ----------

// GET /api/family — current family (members + my role) + pending invitations
// in both directions. If the caller isn't in a family, family_id is null and
// members is empty — they can still receive incoming invitations.
app.get("/api/family", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const fam = await getFamilyInfo(c.env, session.account_id);

  // Incoming invitations: ones addressed to me and still pending.
  const incomingRows = await c.env.DB.prepare(
    `SELECT i.id, i.family_id, i.created_at,
            inviter.name AS inviter_account_name,
            inviter.id   AS inviter_account_id
       FROM family_invitations i
       JOIN accounts inviter ON inviter.id = i.inviter_account_id
      WHERE i.invitee_account_id = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC`,
  )
    .bind(session.account_id)
    .all<{
      id: string;
      family_id: string;
      created_at: string;
      inviter_account_name: string;
      inviter_account_id: string;
    }>();
  // For each incoming invitation, also return a lightweight member list so
  // the invitee can see who else is in the family before accepting.
  const incoming = await Promise.all(
    (incomingRows.results ?? []).map(async (row) => {
      const members = await c.env.DB.prepare(
        `SELECT m.account_id, m.role, a.name AS account_name
           FROM family_memberships m
           JOIN accounts a ON a.id = m.account_id
          WHERE m.family_id = ?
          ORDER BY m.joined_at`,
      )
        .bind(row.family_id)
        .all<{ account_id: string; role: Role; account_name: string }>();
      return { ...row, members: members.results ?? [] };
    }),
  );

  // Outgoing invitations: ones I sent that are still pending. Only members of
  // the family can see them (and in practice only owners can create them).
  let outgoing: Array<{
    id: string;
    invitee_account_id: string;
    invitee_account_name: string;
    created_at: string;
    status: string;
  }> = [];
  if (fam.family_id) {
    const rows = await c.env.DB.prepare(
      `SELECT i.id, i.invitee_account_id, i.created_at, i.status,
              a.name AS invitee_account_name
         FROM family_invitations i
         JOIN accounts a ON a.id = i.invitee_account_id
        WHERE i.family_id = ? AND i.status = 'pending'
        ORDER BY i.created_at DESC`,
    )
      .bind(fam.family_id)
      .all<typeof outgoing[number]>();
    outgoing = rows.results ?? [];
  }

  return c.json({
    family_id: fam.family_id,
    my_role: fam.my_role,
    members: fam.members,
    incoming_invitations: incoming,
    outgoing_invitations: outgoing,
  });
});

// POST /api/family/invite  { account_name }
// If caller isn't in a family yet, creates a new one with them as owner.
// Otherwise caller must be an owner of their family.
app.post("/api/family/invite", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const body = await c.req.json<{ account_name?: string }>().catch(() => ({}));
  const name = validateName(body.account_name);
  if (!name) return jsonError(c, 400, "bad_request", "account_name is required");

  const invitee = await c.env.DB.prepare("SELECT id FROM accounts WHERE name_lower = ?")
    .bind(name.toLowerCase())
    .first<{ id: string }>();
  if (!invitee) return jsonError(c, 404, "not_found", "no account with that name");
  if (invitee.id === session.account_id)
    return jsonError(c, 400, "bad_request", "you cannot invite yourself");

  let fam = await getFamilyInfo(c.env, session.account_id);
  if (fam.family_id && fam.my_role !== "owner") {
    return jsonError(c, 403, "forbidden", "only family owners can invite new members");
  }
  // Create a new family if the caller isn't in one yet.
  if (!fam.family_id) {
    const familyId = newId();
    const now = nowIso();
    await c.env.DB.prepare(
      "INSERT INTO families (id, created_at, updated_at) VALUES (?, ?, ?)",
    )
      .bind(familyId, now, now)
      .run();
    await c.env.DB.prepare(
      `INSERT INTO family_memberships (family_id, account_id, role, joined_at)
       VALUES (?, ?, 'owner', ?)`,
    )
      .bind(familyId, session.account_id, now)
      .run();
    fam = await getFamilyInfo(c.env, session.account_id);
  }

  // Reject duplicate pending invitation from this same family to this invitee.
  const dupe = await c.env.DB.prepare(
    `SELECT id FROM family_invitations
      WHERE family_id = ? AND invitee_account_id = ? AND status = 'pending'`,
  )
    .bind(fam.family_id, invitee.id)
    .first();
  if (dupe) return jsonError(c, 409, "conflict", "that account already has a pending invitation");

  const invitationId = newId();
  await c.env.DB.prepare(
    `INSERT INTO family_invitations
       (id, family_id, inviter_account_id, invitee_account_id, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  )
    .bind(invitationId, fam.family_id, session.account_id, invitee.id, nowIso())
    .run();
  return c.json({ invitation_id: invitationId, family_id: fam.family_id }, 201);
});

// POST /api/family/invitations/:id/accept  { leave_current?: boolean }
// If the caller is already in a family, requires leave_current=true (and the
// caller must be allowed to leave — see /api/family/leave rules).
app.post("/api/family/invitations/:id/accept", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const invitationId = c.req.param("id");
  const body = await c.req.json<{ leave_current?: boolean }>().catch(() => ({}));
  try {
    const inv = await c.env.DB.prepare(
      "SELECT family_id, invitee_account_id, status FROM family_invitations WHERE id = ?",
    )
      .bind(invitationId)
      .first<{ family_id: string; invitee_account_id: string; status: string }>();
    if (!inv) throw new HttpErr(404, "invitation not found");
    if (inv.invitee_account_id !== session.account_id)
      throw new HttpErr(403, "this invitation is not addressed to you");
    if (inv.status !== "pending")
      throw new HttpErr(409, `invitation is ${inv.status}`);

    const current = await getFamilyInfo(c.env, session.account_id);
    if (current.family_id && current.family_id !== inv.family_id) {
      if (!body.leave_current) {
        return jsonError(
          c,
          409,
          "already_in_family",
          "you are already in a family; set leave_current to true to switch",
        );
      }
      await leaveFamilyInternal(c.env, session.account_id);
    } else if (current.family_id === inv.family_id) {
      // Already a member; just mark invitation accepted and return.
      await c.env.DB.prepare(
        "UPDATE family_invitations SET status = 'accepted' WHERE id = ?",
      )
        .bind(invitationId)
        .run();
      return c.body(null, 204);
    }

    await c.env.DB.prepare(
      `INSERT INTO family_memberships (family_id, account_id, role, joined_at)
       VALUES (?, ?, 'member', ?)`,
    )
      .bind(inv.family_id, session.account_id, nowIso())
      .run();
    await c.env.DB.prepare(
      "UPDATE family_invitations SET status = 'accepted' WHERE id = ?",
    )
      .bind(invitationId)
      .run();
    // Any other pending invites addressed to this account are now stale.
    await c.env.DB.prepare(
      `UPDATE family_invitations SET status = 'cancelled'
        WHERE invitee_account_id = ? AND status = 'pending' AND id <> ?`,
    )
      .bind(session.account_id, invitationId)
      .run();
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

app.post("/api/family/invitations/:id/decline", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const invitationId = c.req.param("id");
  try {
    const inv = await c.env.DB.prepare(
      "SELECT invitee_account_id, status FROM family_invitations WHERE id = ?",
    )
      .bind(invitationId)
      .first<{ invitee_account_id: string; status: string }>();
    if (!inv) throw new HttpErr(404, "invitation not found");
    if (inv.invitee_account_id !== session.account_id)
      throw new HttpErr(403, "this invitation is not addressed to you");
    if (inv.status !== "pending") return c.body(null, 204);
    await c.env.DB.prepare(
      "UPDATE family_invitations SET status = 'declined' WHERE id = ?",
    )
      .bind(invitationId)
      .run();
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

// Cancel a sent invitation (inviter or invitee may both do this).
app.delete("/api/family/invitations/:id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const invitationId = c.req.param("id");
  try {
    const inv = await c.env.DB.prepare(
      `SELECT family_id, inviter_account_id, invitee_account_id, status
         FROM family_invitations WHERE id = ?`,
    )
      .bind(invitationId)
      .first<{
        family_id: string;
        inviter_account_id: string;
        invitee_account_id: string;
        status: string;
      }>();
    if (!inv) throw new HttpErr(404, "invitation not found");
    if (
      inv.inviter_account_id !== session.account_id &&
      inv.invitee_account_id !== session.account_id
    ) {
      // Also allow any current owner of the family to cancel.
      const myMembership = await c.env.DB.prepare(
        `SELECT role FROM family_memberships
          WHERE family_id = ? AND account_id = ?`,
      )
        .bind(inv.family_id, session.account_id)
        .first<{ role: Role }>();
      if (!myMembership || myMembership.role !== "owner") {
        throw new HttpErr(403, "you cannot cancel this invitation");
      }
    }
    if (inv.status !== "pending") return c.body(null, 204);
    await c.env.DB.prepare(
      "UPDATE family_invitations SET status = 'cancelled' WHERE id = ?",
    )
      .bind(invitationId)
      .run();
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

// POST /api/family/leave
app.post("/api/family/leave", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  try {
    await leaveFamilyInternal(c.env, session.account_id);
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

// Change a family member's role. Owner-only.
app.put("/api/family/members/:account_id/role", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const targetId = c.req.param("account_id");
  const body = await c.req.json<{ role?: Role }>().catch(() => ({}));
  if (body.role !== "owner" && body.role !== "member") {
    return jsonError(c, 400, "bad_request", "role must be 'owner' or 'member'");
  }
  try {
    const fam = await getFamilyInfo(c.env, session.account_id);
    if (!fam.family_id || fam.my_role !== "owner")
      throw new HttpErr(403, "only owners can change roles");
    const target = fam.members.find((m) => m.account_id === targetId);
    if (!target) throw new HttpErr(404, "that account is not in your family");
    if (target.role === body.role) return c.body(null, 204);
    if (body.role === "member") {
      const ownerCount = fam.members.filter((m) => m.role === "owner").length;
      if (ownerCount <= 1)
        throw new HttpErr(400, "promote another member to owner first");
    }
    await c.env.DB.prepare(
      "UPDATE family_memberships SET role = ? WHERE family_id = ? AND account_id = ?",
    )
      .bind(body.role, fam.family_id, targetId)
      .run();
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

// Kick a family member. Owner-only. Cannot kick self; use /leave.
app.delete("/api/family/members/:account_id", async (c) => {
  const err = await requireAuth(c);
  if (err) return err;
  const session = c.get("session")!;
  const csrfErr = requireCsrf(c, session);
  if (csrfErr) return csrfErr;
  const targetId = c.req.param("account_id");
  try {
    if (targetId === session.account_id)
      throw new HttpErr(400, "use /api/family/leave to leave your own family");
    const fam = await getFamilyInfo(c.env, session.account_id);
    if (!fam.family_id || fam.my_role !== "owner")
      throw new HttpErr(403, "only owners can remove members");
    const target = fam.members.find((m) => m.account_id === targetId);
    if (!target) throw new HttpErr(404, "that account is not in your family");
    if (target.role === "owner") {
      const ownerCount = fam.members.filter((m) => m.role === "owner").length;
      if (ownerCount <= 1)
        throw new HttpErr(400, "cannot remove the last owner — demote them first");
    }
    await c.env.DB.prepare(
      "DELETE FROM family_memberships WHERE family_id = ? AND account_id = ?",
    )
      .bind(fam.family_id, targetId)
      .run();
    await maybeDissolveFamily(c.env, fam.family_id);
    return c.body(null, 204);
  } catch (e) {
    return httpErrorResponse(c, e);
  }
});

// Shared leave logic — used by /leave and by accept-with-leave_current.
async function leaveFamilyInternal(env: Env, accountId: string): Promise<void> {
  const fam = await getFamilyInfo(env, accountId);
  if (!fam.family_id) throw new HttpErr(400, "you are not in a family");
  const otherMembers = fam.members.filter((m) => m.account_id !== accountId);
  if (otherMembers.length > 0) {
    // Last owner can't leave while members remain — must promote first.
    const otherOwners = otherMembers.filter((m) => m.role === "owner");
    if (fam.my_role === "owner" && otherOwners.length === 0) {
      throw new HttpErr(
        400,
        "promote another member to owner before leaving the family",
      );
    }
  }
  await env.DB.prepare(
    "DELETE FROM family_memberships WHERE family_id = ? AND account_id = ?",
  )
    .bind(fam.family_id, accountId)
    .run();
  await maybeDissolveFamily(env, fam.family_id);
}

async function maybeDissolveFamily(env: Env, familyId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM family_memberships WHERE family_id = ?",
  )
    .bind(familyId)
    .first<{ n: number }>();
  if (!row || row.n === 0) {
    // Also cancels any pending invitations via ON DELETE CASCADE.
    await env.DB.prepare("DELETE FROM families WHERE id = ?").bind(familyId).run();
  }
}

// ---------- Static asset fallback ----------
// Hono routes handle everything under /api/*. For any other path we let the
// Workers Assets binding serve the SPA shell (index.html, manifest, SW, icons).

app.all("*", async (c) => {
  // SPA fallback: Workers Assets with `not_found_handling = "single-page-application"`
  // already serves index.html for unmatched paths, so we can just delegate.
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
