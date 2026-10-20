// Receives Apple Health values from the iPhone Shortcut "Wochenduell Sync".
// URL: /functions/v1/health-sync[?format=text]
// Body (JSON, from the Shortcut): { "key": "<personal sync key>", "steps": "...", "active": "...", "eaten": "..." }
// Each value is either one number (today) or one line per day "yyyy-MM-dd;value", newest first,
// as the Shortcut writes them. Today and yesterday are saved, so yesterday's final total gets
// corrected too. Query parameters with the same names work as well. Deployed with
// --no-verify-jwt: the personal key is the only credential.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LIMITS = { steps: 200000, active: 20000, eaten: 20000 } as const;
type Field = keyof typeof LIMITS;
const FIELDS: Field[] = ['steps', 'active', 'eaten'];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Numbers arrive as JSON numbers or as text formatted by the phone: "8432", "8.432",
// "1.234,5", "486,23" or "486,235". With a single separator we take it as thousands
// grouping when that gives a plausible value, otherwise as the decimal mark.
// Zero, empty or implausible values count as "no value" so they never overwrite real data.
export function toInt(v: unknown, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else {
    let s = String(v).trim().replace(/[\s  ']/g, '').replace(/[^0-9.,]/g, '');
    if (!s) return null;
    const dot = s.lastIndexOf('.');
    const comma = s.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) {
      const dec = Math.max(dot, comma);
      n = Number(s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1));
    } else if (dot >= 0 || comma >= 0) {
      const parts = s.split(dot >= 0 ? '.' : ',');
      const grouped = Number(parts.join(''));
      const looksGrouped = parts.length > 2 || parts.slice(1).every((p) => p.length === 3);
      n = looksGrouped && grouped <= max ? grouped : Number(parts[0] + '.' + parts.slice(1).join(''));
    } else {
      n = Number(s);
    }
  }
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r > 0 && r <= max ? r : null;
}

// "yyyy-MM-dd;value" lines -> { day: value }. A bare number counts as today's value.
export function perDay(v: unknown, max: number, today: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (v === null || v === undefined) return out;
  const text = String(v);
  const lines = [...text.matchAll(/(\d{4}-\d{2}-\d{2})\s*;\s*([^\n\r;]*)/g)];
  if (!lines.length) {
    out.set(today, toInt(v, max));
    return out;
  }
  for (const [, day, value] of lines) {
    if (!out.has(day)) out.set(day, toInt(value, max)); // newest first; keep the first per day
  }
  return out;
}

function berlinDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Texts for the Shortcut's notification (?format=text). The person's language is not known
// before the key is checked, so those two messages are bilingual.
const TEXT = {
  noKey: 'Wochenduell: Bitte starte das über den Button „Aus Apple Health übernehmen“ in der App. / Please use the “Import from Apple Health” button in the app.',
  badKey: 'Wochenduell: Dieser Schlüssel gilt nicht mehr. Starte es bitte über den Button in der App. / This key is no longer valid. Please use the button in the app.',
  error: 'Wochenduell: Gerade gibt es ein Problem. Versuch es gleich nochmal. / Something went wrong. Please try again in a moment.',
};
function summary(lang: string, v: Record<Field, number | null>) {
  const de = lang !== 'en';
  const f = (n: number) => n.toLocaleString(de ? 'de-DE' : 'en-GB');
  const parts = [
    v.steps != null ? `${f(v.steps)} ${de ? 'Schritte' : 'steps'}` : null,
    v.active != null ? `${f(v.active)} kcal ${de ? 'aktiv' : 'active'}` : null,
    v.eaten != null ? `${f(v.eaten)} kcal ${de ? 'gegessen' : 'eaten'}` : null,
  ].filter(Boolean);
  if (!parts.length) return de ? 'Wochenduell: In Apple Health sind für heute noch keine Werte.' : 'Wochenduell: Apple Health has no values for today yet.';
  return (de ? 'Übernommen: ' : 'Imported: ') + parts.join(' · ');
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    const text = await req.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') body = parsed;
      } catch {
        return json({ ok: false, error: 'invalid_json' }, 400);
      }
    }
  }
  const pick = (name: string) => (body[name] ?? url.searchParams.get(name)) as unknown;
  // The Shortcut asks for a short plain-text answer it can show as a notification.
  const asText = String(pick('format') ?? '') === 'text';
  const textReply = (msg: string) => new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

  // Accept the bare key or anything containing it (older app versions sent the whole link).
  const keyMatch = String(pick('key') ?? '').match(UUID_ANY);
  if (!keyMatch) return asText ? textReply(TEXT.noKey) : json({ ok: false, error: 'missing_or_invalid_key' }, 400);
  const key = keyMatch[0];

  const today = berlinDay();
  const yesterday = berlinDay(-1);
  const days = new Map<string, Record<Field, number | null>>();
  for (const field of FIELDS) {
    for (const [day, value] of perDay(pick(field), LIMITS[field], today)) {
      if (day !== today && day !== yesterday) continue;
      const row = days.get(day) ?? { steps: null, active: null, eaten: null };
      row[field] = value;
      days.set(day, row);
    }
  }
  if (!days.has(today)) days.set(today, { steps: null, active: null, eaten: null });

  // Yesterday first, so today's call is the one that stamps "last synced".
  for (const day of [yesterday, today]) {
    const v = days.get(day);
    if (!v) continue;
    if (day === yesterday && v.steps == null && v.active == null && v.eaten == null) continue;
    const { error } = await admin.rpc('apply_health_sync', {
      p_key: key, p_day: day, p_steps: v.steps, p_active: v.active, p_eaten: v.eaten,
    });
    if (error) {
      if (String(error.message).includes('invalid_key')) return asText ? textReply(TEXT.badKey) : json({ ok: false, error: 'unknown_key' }, 403);
      console.error(error);
      return asText ? textReply(TEXT.error) : json({ ok: false, error: 'server_error' }, 500);
    }
  }

  const { data: row } = await admin.from('sync_keys').select('user_id').eq('key', key).maybeSingle();
  if (row) {
    const clip = (x: unknown) => (x == null ? null : String(x).slice(0, 400));
    const raw = { steps: clip(pick('steps')), active: clip(pick('active')), eaten: clip(pick('eaten')), method: req.method };
    const { error: logError } = await admin.from('health_sync_log').insert({ user_id: row.user_id, raw });
    if (logError) console.error(logError);
  }
  const saved = days.get(today)!;
  if (asText) {
    const { data: prof } = row ? await admin.from('profiles').select('language').eq('id', row.user_id).maybeSingle() : { data: null };
    return textReply(summary(prof?.language ?? 'de', saved));
  }
  return json({ ok: true, day: today, saved, yesterday: days.get(yesterday) ?? null });
});
