import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

/** Deja solo dígitos para comparar números y armar el destino de `tel:`. */
export function sanitizePhoneForCall(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Formato E.164 para MicroSIP u otro handler del SO (`tel:+57300...`). */
function toE164TelHref(digits: string): string {
  return `tel:+${digits}`;
}

export type RegisterCrmCallResult =
  | { ok: true }
  | { ok: false; error: string };

/** Registra la llamada vía RPC (auth.uid(), activity_logs y contadores en servidor). */
async function recordClientCall(clientPhone: string): Promise<void> {
  const trimmedPhone = clientPhone.trim();
  if (!trimmedPhone) {
    throw new Error("Teléfono inválido.");
  }

  const { error } = await supabase.rpc("register_crm_call", {
    client_phone_param: trimmedPhone,
  });

  if (error) throw error;
}

/** Registra la llamada en Supabase (total_calls, last_contacted, activity_logs). */
export async function registerCrmCall(
  phone: string,
): Promise<RegisterCrmCallResult> {
  const trimmed = phone.trim();
  if (!trimmed) {
    return { ok: false, error: "Teléfono inválido." };
  }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) {
    return { ok: false, error: authError.message };
  }

  if (!user?.id) {
    return { ok: false, error: "No autorizado." };
  }

  try {
    await recordClientCall(trimmed);
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "No se pudo registrar la llamada.";
    return { ok: false, error: message };
  }
}

/**
 * Registra la llamada en la BD y abre MicroSIP vía `tel:`.
 * Espera a que Supabase confirme el registro antes de abrir el marcador.
 */
export async function initiateLocalPhoneCall(
  phone: string | null | undefined,
): Promise<boolean> {
  const trimmed = (phone ?? "").trim();
  const clean = sanitizePhoneForCall(trimmed);
  if (!clean) return false;

  const result = await registerCrmCall(trimmed);
  if (!result.ok) {
    toast.error(result.error);
    return false;
  }

  window.location.href = toE164TelHref(clean);
  return true;
}
