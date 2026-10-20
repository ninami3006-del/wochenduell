// Receives today's Apple Health values from the iPhone Shortcut.
// URL: /functions/v1/health-sync?key=<personal sync key>
// Body (JSON, from the Shortcut): { "steps": 8432, "active": 486.2, "eaten": 1640 }
// Query parameters with the same names work too. Deployed with --no-verify-jwt:
// the personal key is the only credential.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { steps: 200000, active: 20000, eaten: 20000 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Numbers can arrive as JSON numbers or as text such as "8.432", "1.234,5" or "486,2".
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
      s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
    } else if (dot >= 0 || comma >= 0) {
      const parts = s.split(dot >= 0 ? '.' : ',');
      const thousands = parts.length > 2 || (parts[1].length === 3 && parts[0].length <= 3 && parts[0] !== '0');
      s = thousands ? parts.join('') : parts[0] + '.' + parts[1];
    }
    n = Number(s);
  }
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r > 0 && r <= max ? r : null;
}

function berlinDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
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

  const key = String(pick('key') ?? '').trim();
  if (!UUID.test(key)) return json({ ok: false, error: 'missing_or_invalid_key' }, 400);

  // Today in German time; a Shortcut may also send yesterday's values with "day".
  let day = berlinDay();
  const askedDay = String(pick('day') ?? '').trim();
  if (askedDay && [berlinDay(), berlinDay(-1)].includes(askedDay)) day = askedDay;

  const steps = toInt(pick('steps'), LIMITS.steps);
  const active = toInt(pick('active'), LIMITS.active);
  const eaten = toInt(pick('eaten'), LIMITS.eaten);

  const { data, error } = await admin.rpc('apply_health_sync', {
    p_key: key, p_day: day, p_steps: steps, p_active: active, p_eaten: eaten,
  });
  if (error) {
    if (String(error.message).includes('invalid_key')) return json({ ok: false, error: 'unknown_key' }, 403);
    console.error(error);
    return json({ ok: false, error: 'server_error' }, 500);
  }
  return json({ ok: true, name: data, day, saved: { steps, active, eaten } });
});
