import { createFileRoute } from "@tanstack/react-router";

import {
  sanitizeDbClientRow,
  phoneComparisonKey,
  type DbClientRow,
} from "@/lib/client-import";
import { normalizeLeadStatus, type LeadStatus } from "@/lib/secure-clients";
import { supabaseAdmin } from "@/utils/supabaseAdmin";

const TRACKBOX_ACTIVITY_TEXT =
  "Lead ingresado automáticamente vía API Trackbox";

const BULK_CHUNK_SIZE = 200;

const DEFAULT_REPORT_LIMIT = 100;

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const TP_ACCOUNT_MIN = 10_000_000;
const TP_ACCOUNT_MAX = 99_999_999;

/** UUID de Supabase — afiliadora Diamond (flujo por defecto). */
const DEFAULT_AFFILIATE_UUID = "061d974b-b5ac-466d-abbd-36087e3c3d00";

/** UUID de Supabase — afiliadora Diamond Potential. */
const DIAMOND_POTENTIAL_AFFILIATE_UUID = "d2b0d2cf-e016-4abc-8869-2edc88f99a8d";

/** Mapeo de identificadores entrantes (`affiliate_id`) → UUID de afiliadora en Supabase. */
const MAPEO_AFILIADORAS: Record<string, string> = {
  diamond_potential: DIAMOND_POTENTIAL_AFFILIATE_UUID,
};

interface AffiliateAssignment {
  affiliateName: string;
  ownerId: string;
}

/** Configuración de inserción por UUID de afiliadora resuelto. */
const AFFILIATE_ASSIGNMENT_BY_UUID: Record<string, AffiliateAssignment> = {
  [DEFAULT_AFFILIATE_UUID]: {
    affiliateName: "Diamond",
    ownerId: DEFAULT_AFFILIATE_UUID,
  },
  [DIAMOND_POTENTIAL_AFFILIATE_UUID]: {
    affiliateName: "Diamond Potential",
    ownerId: DIAMOND_POTENTIAL_AFFILIATE_UUID,
  },
};

const CLIENT_SELECT =
  "phone, first_name, last_name, email, country, affiliate, lead_status, tp_account, owner_id, total_calls, created_on, last_contacted, updated_at";

const ACTIVITY_LOG_SELECT = `
  id,
  client_phone,
  agent_id,
  text,
  type,
  created_at,
  profiles (
    first_name,
    last_name,
    email
  )
`;

interface TrackboxLeadBody {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  country: string;
  tp_account?: string | null;
  affiliate_id?: string | null;
}

interface ParsedTrackboxLead {
  lead: TrackboxLeadBody;
  affiliateUuid: string;
}

type ResolveAffiliateError = { ok: false; error: string };

function isResolveAffiliateError(
  value: unknown,
): value is ResolveAffiliateError {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as ResolveAffiliateError).ok === false
  );
}

interface ActivityLogProfile {
  first_name: string | null;
  last_name: string | null;
  email: string;
}

interface ActivityHistoryEntry {
  id: string;
  client_phone: string;
  agent_id: string;
  text: string;
  type: string;
  created_at: string;
  profiles: ActivityLogProfile | ActivityLogProfile[] | null;
}

interface ClientRecord {
  phone: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  country: string | null;
  affiliate: string | null;
  lead_status: LeadStatus | string | null;
  tp_account: string | null;
  owner_id: string | null;
  total_calls: number | null;
  created_on: string | null;
  last_contacted: string | null;
  updated_at: string | null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Código de 8 dígitos (10000000–99999999); el primer dígito nunca es 0. */
function generateTpAccount(): string {
  const value =
    Math.floor(Math.random() * (TP_ACCOUNT_MAX - TP_ACCOUNT_MIN + 1)) +
    TP_ACCOUNT_MIN;
  return String(value);
}

async function fetchExistingTpAccounts(codes: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  if (codes.length === 0) return existing;

  for (let i = 0; i < codes.length; i += BULK_CHUNK_SIZE) {
    const chunk = codes.slice(i, i + BULK_CHUNK_SIZE);
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("tp_account")
      .in("tp_account", chunk);

    if (error) throw error;
    for (const row of data ?? []) {
      if (row.tp_account) existing.add(String(row.tp_account));
    }
  }

  return existing;
}

async function generateUniqueTpAccount(): Promise<string> {
  let code = generateTpAccount();

  while (true) {
    const existing = await fetchExistingTpAccounts([code]);
    if (!existing.has(code)) return code;
    code = generateTpAccount();
  }
}

function generateUniqueTpAccountInBatch(inBatch: Set<string>): string {
  let code = generateTpAccount();
  while (inBatch.has(code)) {
    code = generateTpAccount();
  }
  inBatch.add(code);
  return code;
}

async function assignUniqueTpAccountsBulk(payloads: DbClientRow[]): Promise<void> {
  const count = payloads.length;
  if (count === 0) return;

  const codes: string[] = [];
  const inBatch = new Set<string>();

  for (let i = 0; i < count; i++) {
    codes.push(generateUniqueTpAccountInBatch(inBatch));
  }

  let pendingIndices = [...Array(count).keys()];

  while (pendingIndices.length > 0) {
    const codesToCheck = pendingIndices.map((i) => codes[i]);
    const existingInDb = await fetchExistingTpAccounts(codesToCheck);

    const conflictIndices = pendingIndices.filter((i) =>
      existingInDb.has(codes[i]),
    );

    if (conflictIndices.length === 0) break;

    for (const i of conflictIndices) {
      inBatch.delete(codes[i]);
      codes[i] = generateUniqueTpAccountInBatch(inBatch);
    }

    pendingIndices = conflictIndices;
  }

  for (let i = 0; i < count; i++) {
    payloads[i] = sanitizeDbClientRow({
      ...payloads[i],
      tp_account: codes[i],
    });
  }
}

async function checkAuth(request: Request): Promise<Response | null> {
  
  const username = request.headers.get("x-trackbox-username");
  const password = request.headers.get("x-trackbox-password");
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : null;

  if (
    username !== process.env.TRACKBOX_INBOUND_USER ||
    password !== process.env.TRACKBOX_INBOUND_PASSWORD ||
    token !== process.env.TRACKBOX_INBOUND_TOKEN
  ) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}

function phoneQueryVariants(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const hasLeadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  const variants = new Set<string>([trimmed]);

  if (digits) {
    variants.add(digits);
    variants.add(`+${digits}`);
    if (hasLeadingPlus) variants.add(`+${digits}`);
  }

  return [...variants];
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function resolveAffiliateUuid(
  affiliateId: unknown,
): string | ResolveAffiliateError {
  if (
    affiliateId === undefined ||
    affiliateId === null ||
    (typeof affiliateId === "string" && affiliateId.trim() === "")
  ) {
    return DEFAULT_AFFILIATE_UUID;
  }

  if (typeof affiliateId !== "string") {
    return {
      ok: false,
      error: "El identificador de la afiliadora no es válido.",
    };
  }

  const mappedUuid = MAPEO_AFILIADORAS[affiliateId.trim()];
  if (!mappedUuid) {
    return {
      ok: false,
      error: "El identificador de la afiliadora no es válido.",
    };
  }

  return mappedUuid;
}

function extractAffiliateId(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  return (body as Record<string, unknown>).affiliate_id;
}

function parseTrackboxLeadBody(body: unknown): TrackboxLeadBody | null {
  if (!body || typeof body !== "object") return null;

  const record = body as Record<string, unknown>;
  const tpAccount = record.tp_account;
  const affiliateId = record.affiliate_id;

  if (
    !isNonEmptyString(record.first_name) ||
    !isNonEmptyString(record.last_name) ||
    !isNonEmptyString(record.phone) ||
    !isNonEmptyString(record.email) ||
    !isNonEmptyString(record.country)
  ) {
    return null;
  }

  return {
    first_name: record.first_name.trim(),
    last_name: record.last_name.trim(),
    phone: record.phone.trim(),
    email: record.email.trim(),
    country: record.country.trim(),
    tp_account:
      typeof tpAccount === "string"
        ? tpAccount.trim() || null
        : tpAccount == null
          ? null
          : null,
    affiliate_id:
      typeof affiliateId === "string"
        ? affiliateId.trim() || null
        : affiliateId == null
          ? null
          : null,
  };
}

function parseTrackboxLead(
  body: unknown,
): ParsedTrackboxLead | ResolveAffiliateError | null {
  const affiliateUuid = resolveAffiliateUuid(extractAffiliateId(body));
  if (isResolveAffiliateError(affiliateUuid)) return affiliateUuid;

  const lead = parseTrackboxLeadBody(body);
  if (!lead) return null;

  return {
    lead,
    affiliateUuid,
  };
}

interface BulkUploadSummary {
  processed: true;
  inserted: number;
  skipped_duplicates: number;
}

function toClientPayload(lead: TrackboxLeadBody): DbClientRow {
  return sanitizeDbClientRow({
    first_name: lead.first_name,
    last_name: lead.last_name,
    phone: lead.phone,
    email: lead.email,
    country: lead.country,
    tp_account: null,
    affiliate: null,
    lead_status: "New",
    owner_id: null,
  });
}

function getAffiliateAssignment(affiliateUuid: string): AffiliateAssignment {
  const assignment = AFFILIATE_ASSIGNMENT_BY_UUID[affiliateUuid];
  if (!assignment) {
    throw new Error(
      `Configuración de afiliadora no encontrada para UUID: ${affiliateUuid}`,
    );
  }
  return assignment;
}

/** Inyecta afiliadora y asesor justo antes del insert en Supabase. */
function withAffiliateAssignment(
  row: Omit<DbClientRow, "affiliate" | "owner_id"> &
    Partial<Pick<DbClientRow, "affiliate" | "owner_id">>,
  affiliateUuid: string,
): Record<string, unknown> {
  const assignment = getAffiliateAssignment(affiliateUuid);
  return {
    ...row,
    affiliate: assignment.affiliateName,
    owner_id: assignment.ownerId,
  };
}

function parseTrackboxLeadArray(
  body: unknown,
): ParsedTrackboxLead[] | ResolveAffiliateError | null {
  if (!Array.isArray(body) || body.length === 0) return null;

  const parsed: ParsedTrackboxLead[] = [];
  for (const item of body) {
    const result = parseTrackboxLead(item);
    if (isResolveAffiliateError(result)) return result;
    if (!result) return null;
    parsed.push(result);
  }
  return parsed;
}

async function fetchExistingPhoneKeys(phones: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  const allVariants = new Set<string>();

  for (const phone of phones) {
    const normalized = sanitizeDbClientRow({
      first_name: null,
      last_name: null,
      country: null,
      affiliate: null,
      tp_account: null,
      phone,
      email: null,
      lead_status: "New",
      owner_id: null,
    }).phone;

    for (const variant of phoneQueryVariants(phone)) allVariants.add(variant);
    if (normalized) allVariants.add(normalized);
  }

  const variantList = [...allVariants];
  for (let i = 0; i < variantList.length; i += BULK_CHUNK_SIZE) {
    const chunk = variantList.slice(i, i + BULK_CHUNK_SIZE);
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("phone")
      .in("phone", chunk);

    if (error) throw error;
    for (const row of data ?? []) {
      if (row.phone) keys.add(phoneComparisonKey(String(row.phone)));
    }
  }

  return keys;
}

async function fetchExistingEmailKeys(emails: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (normalized.length === 0) return keys;

  for (let i = 0; i < normalized.length; i += BULK_CHUNK_SIZE) {
    const chunk = normalized.slice(i, i + BULK_CHUNK_SIZE);
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("email")
      .in("email", chunk);

    if (error) throw error;
    for (const row of data ?? []) {
      if (row.email) keys.add(normalizeEmail(String(row.email)));
    }
  }

  return keys;
}

function isLeadDuplicate(
  payload: DbClientRow,
  existingPhoneKeys: Set<string>,
  existingEmailKeys: Set<string>,
  seenPhoneKeys: Set<string>,
  seenEmails: Set<string>,
): boolean {
  const phoneKey = phoneComparisonKey(payload.phone);
  if (phoneKey) {
    if (existingPhoneKeys.has(phoneKey) || seenPhoneKeys.has(phoneKey)) {
      return true;
    }
  }

  if (payload.email) {
    const emailKey = normalizeEmail(payload.email);
    if (existingEmailKeys.has(emailKey) || seenEmails.has(emailKey)) {
      return true;
    }
  }

  return false;
}

function markLeadSeen(
  payload: DbClientRow,
  seenPhoneKeys: Set<string>,
  seenEmails: Set<string>,
): void {
  const phoneKey = phoneComparisonKey(payload.phone);
  if (phoneKey) seenPhoneKeys.add(phoneKey);
  if (payload.email) seenEmails.add(normalizeEmail(payload.email));
}

async function insertActivityLogsForClients(
  phones: string[],
  agentId: string,
): Promise<void> {
  if (phones.length === 0) return;

  for (let i = 0; i < phones.length; i += BULK_CHUNK_SIZE) {
    const chunk = phones.slice(i, i + BULK_CHUNK_SIZE);
    const rows = chunk.map((phone) => ({
      client_phone: phone,
      agent_id: agentId,
      text: TRACKBOX_ACTIVITY_TEXT,
      type: "comment",
    }));

    const { error } = await supabaseAdmin.from("activity_logs").insert(rows);
    if (error) throw error;
  }
}

interface BulkLeadInsertItem {
  payload: DbClientRow;
  affiliateUuid: string;
}

async function insertClientsBulk(items: BulkLeadInsertItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += BULK_CHUNK_SIZE) {
    const chunk = items.slice(i, i + BULK_CHUNK_SIZE);
    const dbPayloads = chunk.map(({ payload, affiliateUuid }) =>
      withAffiliateAssignment(
        {
          first_name: payload.first_name,
          last_name: payload.last_name,
          phone: payload.phone,
          email: payload.email,
          country: payload.country,
          tp_account: payload.tp_account,
          lead_status: payload.lead_status || "New",
        },
        affiliateUuid,
      ),
    );
    const { error } = await supabaseAdmin.from("clients").insert(dbPayloads);
    if (error) throw error;
  }
}

async function processBulkLeads(
  leads: ParsedTrackboxLead[],
): Promise<BulkUploadSummary> {
  const sanitized = leads.map(({ lead, affiliateUuid }) => ({
    payload: sanitizeDbClientRow({
      ...toClientPayload(lead),
    }),
    affiliateUuid,
  }));

  const phones = sanitized.map((row) => row.payload.phone);
  const emails = sanitized
    .map((row) =>
      row.payload.email ? normalizeEmail(row.payload.email) : "",
    )
    .filter(Boolean);

  const [existingPhoneKeys, existingEmailKeys] = await Promise.all([
    fetchExistingPhoneKeys(phones),
    fetchExistingEmailKeys(emails),
  ]);

  const seenPhoneKeys = new Set<string>();
  const seenEmails = new Set<string>();
  const toInsert: BulkLeadInsertItem[] = [];
  let skippedDuplicates = 0;

  for (const item of sanitized) {
    if (
      isLeadDuplicate(
        item.payload,
        existingPhoneKeys,
        existingEmailKeys,
        seenPhoneKeys,
        seenEmails,
      )
    ) {
      skippedDuplicates += 1;
      continue;
    }

    toInsert.push(item);
    markLeadSeen(item.payload, seenPhoneKeys, seenEmails);
  }

  if (toInsert.length > 0) {
    const payloads = toInsert.map((item) => item.payload);
    await assignUniqueTpAccountsBulk(payloads);
    await insertClientsBulk(toInsert);
    const agentId = await resolveSystemAgentId();
    await insertActivityLogsForClients(
      payloads.map((row) => row.phone),
      agentId,
    );
  }

  return {
    processed: true,
    inserted: toInsert.length,
    skipped_duplicates: skippedDuplicates,
  };
}

async function processSingleLead(
  parsedLead: ParsedTrackboxLead,
): Promise<Response> {
  const { lead, affiliateUuid } = parsedLead;
  const conflict = await findExistingClientConflict(lead.phone, lead.email);
  if (conflict) {
    return jsonResponse(
      {
        error: "El cliente ya está registrado en el CRM.",
        conflict_field: conflict,
      },
      409,
    );
  }

  const data = sanitizeDbClientRow({
    ...toClientPayload(lead),
    tp_account: await generateUniqueTpAccount(),
  });

  const { data: createdClient, error: insertError } = await supabaseAdmin
    .from("clients")
    .insert(
      withAffiliateAssignment(
        {
          first_name: data.first_name,
          last_name: data.last_name,
          phone: data.phone,
          email: data.email,
          country: data.country,
          tp_account: data.tp_account,
          lead_status: data.lead_status || "New",
        },
        affiliateUuid,
      ),
    )
    .select(CLIENT_SELECT)
    .single();

  if (insertError) throw insertError;

  const agentId = await resolveSystemAgentId();
  const { error: logError } = await supabaseAdmin.from("activity_logs").insert({
    client_phone: data.phone,
    agent_id: agentId,
    text: TRACKBOX_ACTIVITY_TEXT,
    type: "comment",
  });

  if (logError) throw logError;

  return jsonResponse(createdClient as ClientRecord, 201);
}

async function findExistingClientConflict(
  phone: string,
  email: string | null,
): Promise<"phone" | "email" | null> {
  const normalizedPhone = sanitizeDbClientRow({
    first_name: null,
    last_name: null,
    country: null,
    affiliate: null,
    tp_account: null,
    phone,
    email: null,
    lead_status: "New",
    owner_id: null,
  }).phone;

  const variants = [
    ...new Set([...phoneQueryVariants(phone), normalizedPhone].filter(Boolean)),
  ];

  if (variants.length > 0) {
    const { data: phoneMatches, error: phoneError } = await supabaseAdmin
      .from("clients")
      .select("phone")
      .in("phone", variants)
      .limit(1);

    if (phoneError) throw phoneError;
    if ((phoneMatches?.length ?? 0) > 0) return "phone";
  }

  if (email) {
    const normalizedEmail = normalizeEmail(email);
    const { data: emailMatches, error: emailError } = await supabaseAdmin
      .from("clients")
      .select("email")
      .ilike("email", normalizedEmail)
      .limit(1);

    if (emailError) throw emailError;
    if ((emailMatches?.length ?? 0) > 0) return "email";
  }

  return null;
}

let cachedSystemAgentId: string | null | undefined;

async function resolveSystemAgentId(): Promise<string> {
  if (cachedSystemAgentId) return cachedSystemAgentId;

  const fromEnv = process.env.TRACKBOX_SYSTEM_AGENT_ID?.trim();
  if (fromEnv) {
    cachedSystemAgentId = fromEnv;
    return fromEnv;
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("role", "Admin")
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) {
    throw new Error(
      "No se encontró un perfil Admin para registrar la nota de actividad.",
    );
  }

  cachedSystemAgentId = data.id;
  return data.id;
}

async function findClientByIdentifier(
  email: string | null,
  phone: string | null,
  tpAccount: string | null,
): Promise<ClientRecord | null> {
  if (phone) {
    const normalizedPhone = sanitizeDbClientRow({
      first_name: null,
      last_name: null,
      country: null,
      affiliate: null,
      tp_account: null,
      phone,
      email: null,
      lead_status: "New",
      owner_id: null,
    }).phone;

    const variants = [
      ...new Set([...phoneQueryVariants(phone), normalizedPhone].filter(Boolean)),
    ];

    if (variants.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select(CLIENT_SELECT)
        .in("phone", variants)
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (data) return data as ClientRecord;
    }
  }

  if (email) {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select(CLIENT_SELECT)
      .ilike("email", normalizeEmail(email))
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (data) return data as ClientRecord;
  }

  if (tpAccount) {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select(CLIENT_SELECT)
      .eq("tp_account", tpAccount)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (data) return data as ClientRecord;
  }

  return null;
}

function parseStartDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (DATE_ONLY_REGEX.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseEndDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (DATE_ONLY_REGEX.test(trimmed)) {
    return `${trimmed}T23:59:59.999Z`;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

interface ClientReportFilters {
  startDate: string | null;
  endDate: string | null;
  leadStatus: LeadStatus | string | null;
}

async function fetchClientsReport(
  filters: ClientReportFilters,
  applyDefaultLimit: boolean,
): Promise<ClientRecord[]> {
  let query = supabaseAdmin.from("clients").select(CLIENT_SELECT);

  if (filters.startDate) {
    query = query.gte("created_on", filters.startDate);
  }
  if (filters.endDate) {
    query = query.lte("created_on", filters.endDate);
  }
  if (filters.leadStatus) {
    query = query.eq("lead_status", filters.leadStatus);
  }

  query = query.order("created_on", { ascending: false });

  if (applyDefaultLimit) {
    query = query.limit(DEFAULT_REPORT_LIMIT);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ClientRecord[];
}

async function handlePointSearch(
  email: string | null,
  phone: string | null,
  tpAccount: string | null,
): Promise<Response> {
  const client = await findClientByIdentifier(email, phone, tpAccount);
  if (!client) {
    return jsonResponse({ error: "Cliente no encontrado." }, 404);
  }

  const history = await fetchClientHistory(client.phone);
  return jsonResponse({ client, history }, 200);
}

async function handleReportSearch(url: URL): Promise<Response> {
  const startDateRaw = url.searchParams.get("start_date")?.trim() ?? "";
  const endDateRaw = url.searchParams.get("end_date")?.trim() ?? "";
  const leadStatusRaw = url.searchParams.get("lead_status")?.trim() ?? "";

  const startDate = startDateRaw ? parseStartDate(startDateRaw) : null;
  if (startDateRaw && !startDate) {
    return jsonResponse(
      { error: "start_date inválido. Use YYYY-MM-DD o ISO 8601." },
      400,
    );
  }

  const endDate = endDateRaw ? parseEndDate(endDateRaw) : null;
  if (endDateRaw && !endDate) {
    return jsonResponse(
      { error: "end_date inválido. Use YYYY-MM-DD o ISO 8601." },
      400,
    );
  }

  if (startDate && endDate && startDate > endDate) {
    return jsonResponse(
      { error: "start_date no puede ser posterior a end_date." },
      400,
    );
  }

  const leadStatus = leadStatusRaw
    ? normalizeLeadStatus(leadStatusRaw)
    : null;

  const hasReportFilters = Boolean(startDate || endDate || leadStatus);
  const clients = await fetchClientsReport(
    { startDate, endDate, leadStatus },
    !hasReportFilters,
  );

  return jsonResponse({ count: clients.length, clients }, 200);
}

async function fetchClientHistory(phone: string): Promise<ActivityHistoryEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("activity_logs")
    .select(ACTIVITY_LOG_SELECT)
    .eq("client_phone", phone)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as ActivityHistoryEntry[];
}

export const Route = createFileRoute("/api/v1/leads")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await checkAuth(request);
        if (authError) return authError;

        try {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return jsonResponse(
              { error: "El cuerpo de la petición debe ser JSON válido." },
              400,
            );
          }

          if (Array.isArray(body)) {
            const bulkLeads = parseTrackboxLeadArray(body);
            if (isResolveAffiliateError(bulkLeads)) {
              return jsonResponse({ error: bulkLeads.error }, 400);
            }
            if (!bulkLeads) {
              return jsonResponse(
                {
                  error:
                    "Cada lead del array debe incluir first_name, last_name, phone, email y country.",
                },
                400,
              );
            }

            const summary = await processBulkLeads(bulkLeads);
            return jsonResponse(summary, 200);
          }

          const parsed = parseTrackboxLead(body);
          if (isResolveAffiliateError(parsed)) {
            return jsonResponse({ error: parsed.error }, 400);
          }
          if (!parsed) {
            return jsonResponse(
              {
                error:
                  "Campos requeridos: first_name, last_name, phone, email, country.",
              },
              400,
            );
          }

          return await processSingleLead(parsed);
        } catch (err) {
          console.error("POST /api/v1/leads:", err);
          const message =
            err instanceof Error
              ? err.message
              : "Error interno al crear el lead.";
          return jsonResponse({ error: message }, 500);
        }
      },

      GET: async ({ request }) => {
        const authError = await checkAuth(request);
        if (authError) return authError;

        try {
          const url = new URL(request.url);
          const email = url.searchParams.get("email")?.trim() || null;
          const phone = url.searchParams.get("phone")?.trim() || null;
          const tpAccount = url.searchParams.get("tp_account")?.trim() || null;

          if (email || phone || tpAccount) {
            return await handlePointSearch(email, phone, tpAccount);
          }

          return await handleReportSearch(url);
        } catch (err) {
          console.error("GET /api/v1/leads:", err);
          const message =
            err instanceof Error
              ? err.message
              : "Error interno al consultar el lead.";
          return jsonResponse({ error: message }, 500);
        }
      },
    },
  },
});
