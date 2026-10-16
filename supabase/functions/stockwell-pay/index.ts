// stockwell-pay: "Pay now" for signed agreements on stockwellmedia.com/sign/.
//   POST {token}                 -> {url} of a Stripe Checkout page (build fee + monthly plan or prepay)
//   POST from Stripe (signature) -> webhook: records payment on stockwell.agreements, texts Stock via the hub outbox
// Secrets: STRIPE_KEY (restricted key, edge secret). Webhook signing secret is created on first use and kept in
// stockwell.secrets ('stripe_webhook_secret_test' / '_live'). Amounts always come from the DB row, never the browser.
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const KEY = Deno.env.get("STRIPE_KEY") ?? "";
const MODE = KEY.includes("_live_") ? "live" : "test";
const SELF = "https://souugetwznrxjtlasdtb.supabase.co/functions/v1/stockwell-pay";
const SITE = "https://stockwellmedia.com/sign/?k=";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---- Stripe REST helpers --------------------------------------------------------------------------
function form(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method: string, path: string, body?: Record<string, unknown>) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? form(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`stripe ${path}: ${d?.error?.message ?? r.status}`);
  return d;
}

// ---- webhook endpoint (created once per mode) -------------------------------------------------------
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "invoice.payment_failed",
];
async function webhookSecret(create: boolean): Promise<string | null> {
  const name = "stripe_webhook_secret_" + MODE;
  const [row] = await sql`select value from stockwell.secrets where key = ${name}`;
  if (row || !create) return row?.value ?? null;
  const ep = await stripe("POST", "webhook_endpoints", {
    url: SELF,
    description: "Stockwell sign page payments",
    enabled_events: Object.fromEntries(EVENTS.map((e, i) => [i, e])),
  });
  await sql`insert into stockwell.secrets(key, value) values (${name}, ${ep.secret})
            on conflict (key) do update set value = excluded.value`;
  return ep.secret;
}
async function verify(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2)));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 600) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  return sigs.some((s) => s.length === hex.length && [...s].every((c, i) => c === hex[i]));
}

// ---- iMessage alert through the hub outbox ----------------------------------------------------------
async function alert(label: string, token: string) {
  try {
    const rows = await sql`select key, value from stockwell.secrets where key in ('sign_alert_secret','hub_anon_key')`;
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!s.sign_alert_secret || !s.hub_anon_key) return;
    await fetch("https://gzcfawhglecmfxnwfjej.supabase.co/rest/v1/rpc/stockwell_sign_alert", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: s.hub_anon_key, Authorization: "Bearer " + s.hub_anon_key },
      body: JSON.stringify({ p_secret: s.sign_alert_secret, p_label: label, p_link: SITE + token }),
    });
  } catch (e) {
    console.error("alert failed", e);
  }
}

// ---- amounts ---------------------------------------------------------------------------------------
const cents = (v: unknown) => Math.round(Number(String(v ?? "").replace(/[^0-9.]/g, "")) * 100);
const usd = (c: number) => "$" + (c / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
// monthly billing starts on the 1st of the month after the planned launch (signed_at + launch_days);
// the sign page shows the same date. Stripe needs a trial end at least 2 days out.
function firstBillingDate(signedAt: Date, launchDays: number) {
  const d = new Date(signedAt.getTime() + (launchDays || 14) * 86400000);
  let ts = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 15) / 1000; // 15:00 UTC = morning CT
  while (ts < Date.now() / 1000 + 3 * 86400) {
    const n = new Date(ts * 1000);
    ts = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1, 15) / 1000;
  }
  return ts;
}

async function checkout(token: string) {
  const [a] = await sql`select * from stockwell.agreements where token = ${token}`;
  if (!a || a.status !== "signed") return json({ status: "invalid" });
  if (a.pay_status === "paid" || a.pay_status === "processing") return json({ status: a.pay_status });
  await webhookSecret(true);

  const t = a.terms, ch = a.choices;
  const build = t.build.find((b: { id: string }) => b.id === ch.build);
  const pay = t.pay.find((p: { id: string }) => p.id === ch.pay);
  if (!build || !pay) return json({ status: "invalid" });
  const client = a.business_name || t.client;
  const buildLine = {
    quantity: 1,
    price_data: { currency: "usd", unit_amount: cents(build.price), product_data: { name: `Website build: ${build.name}` } },
  };
  const common = {
    success_url: SITE + token + "&paid=1",
    cancel_url: SITE + token,
    client_reference_id: token,
    metadata: { token },
    payment_method_types: { 0: "us_bank_account", 1: "card" },
    payment_method_options: { us_bank_account: { verification_method: "automatic" } },
    billing_address_collection: "auto",
  };
  const monthly = pay.id === "monthly";
  const start = firstBillingDate(new Date(a.signed_at), t.launch_days);
  const startText = new Date(start * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Chicago" });
  // Build fee (plus prepay) is a one-time checkout. On the monthly plan the checkout also saves the payment method,
  // and the webhook starts the $200/mo subscription from that saved method (see startMonthly).
  const total = cents(build.price) + (monthly ? 0 : cents(pay.price));
  const session = await stripe("POST", "checkout/sessions", {
    ...common,
    mode: "payment",
    customer_creation: "always",
    line_items: {
      0: buildLine,
      ...(monthly ? {} : {
        1: { quantity: 1, price_data: { currency: "usd", unit_amount: cents(pay.price), product_data: { name: `Website plan: ${pay.name}` } } },
      }),
    },
    metadata: { token, ...(monthly ? { monthly_start: start } : {}) },
    custom_text: {
      submit: {
        message: monthly
          ? `Then ${usd(cents(t.monthly))} a month for the website plan, charged automatically on the 1st starting ${startText}. ${client} website agreement ${token}.`
          : `${client} website agreement ${token}.`,
      },
    },
    payment_intent_data: {
      metadata: { token, client },
      description: monthly ? `${client} website build` : `${client} website build and ${pay.name}`,
      ...(monthly ? { setup_future_usage: "off_session" } : {}),
    },
    invoice_creation: { enabled: true },
  });
  await sql`update stockwell.agreements set stripe_session = ${session.id}, pay_amount_cents = ${total} where token = ${token}`;
  return json({ status: "ok", url: session.url });
}

// Starts the monthly plan on the payment method saved at checkout. First charge lands on the 1st (billing anchor,
// no proration); if Stripe won't take an anchor that far out, a trial ending on the same date does the same job.
async function startMonthly(session: Record<string, any>, token: string) {
  const [a] = await sql`select terms, business_name, stripe_subscription from stockwell.agreements where token = ${token}`;
  if (a.stripe_subscription) return a.stripe_subscription;
  const pi = await stripe("GET", "payment_intents/" + session.payment_intent);
  const productKey = "stripe_monthly_product_" + MODE;
  let [prod] = await sql`select value from stockwell.secrets where key = ${productKey}`;
  if (!prod) {
    const p = await stripe("POST", "products", { name: "Website monthly plan" });
    await sql`insert into stockwell.secrets(key, value) values (${productKey}, ${p.id}) on conflict (key) do update set value = excluded.value`;
    prod = { value: p.id };
  }
  const client = a.business_name || a.terms.client;
  const base = {
    customer: session.customer,
    default_payment_method: pi.payment_method,
    items: { 0: { price_data: { currency: "usd", product: prod.value, unit_amount: cents(a.terms.monthly), recurring: { interval: "month" } } } },
    metadata: { token, client },
    description: `${client} website monthly plan`,
  };
  const start = Number(session.metadata.monthly_start);
  let sub;
  try {
    sub = await stripe("POST", "subscriptions", { ...base, billing_cycle_anchor: start, proration_behavior: "none" });
  } catch (e) {
    console.error("anchor rejected, using trial_end", e);
    sub = await stripe("POST", "subscriptions", { ...base, trial_end: start });
  }
  await sql`update stockwell.agreements set stripe_subscription = ${sub.id} where token = ${token}`;
  return sub.id;
}

async function webhook(req: Request, sigHeader: string) {
  const raw = await req.text();
  const secret = await webhookSecret(false);
  if (!secret || !(await verify(raw, sigHeader, secret))) return new Response("bad signature", { status: 400 });
  const ev = JSON.parse(raw), o = ev.data.object;
  const token: string | undefined = o.metadata?.token || o.client_reference_id || o.subscription_details?.metadata?.token;
  if (!token) return json({ ok: true, skipped: true });
  const [a] = await sql`select label, pay_status, pay_amount_cents from stockwell.agreements where token = ${token}`;
  if (!a) return json({ ok: true, skipped: true });
  // belt and braces: re-read checkout sessions straight from Stripe instead of trusting the event body
  if (ev.type.startsWith("checkout.session.")) Object.assign(o, await stripe("GET", "checkout/sessions/" + o.id));
  const amt = usd(o.amount_total ?? o.amount_due ?? 0);
  if (ev.type.startsWith("checkout.session.") && a.pay_amount_cents && o.amount_total !== a.pay_amount_cents) {
    await alert(`${a.label} checkout total ${amt} does not match the agreement, check Stripe`, token);
    return json({ ok: true, mismatch: true });
  }

  if (ev.type === "checkout.session.completed") {
    const paid = o.payment_status === "paid" || o.payment_status === "no_payment_required";
    await sql`update stockwell.agreements set pay_status = ${paid ? "paid" : "processing"},
              paid_at = ${paid ? new Date() : null}, stripe_customer = ${o.customer ?? null},
              stripe_session = ${o.id} where token = ${token}`;
    let note = "";
    if (o.metadata?.monthly_start) {
      try { await startMonthly(o, token); note = ", monthly plan set up"; }
      catch (e) { console.error(e); note = ", but the monthly plan did NOT start, set it up in Stripe"; }
    }
    await alert(paid ? `${a.label} paid ${amt}${note}` : `${a.label} paid ${amt} by bank, clears in about 4 business days${note}`, token);
  } else if (ev.type === "checkout.session.async_payment_succeeded") {
    await sql`update stockwell.agreements set pay_status = 'paid', paid_at = now() where token = ${token}`;
    await alert(`${a.label} bank payment of ${amt} cleared`, token);
  } else if (ev.type === "checkout.session.async_payment_failed") {
    await sql`update stockwell.agreements set pay_status = 'failed' where token = ${token}`;
    const [f] = await sql`select stripe_subscription from stockwell.agreements where token = ${token}`;
    if (f?.stripe_subscription) await stripe("DELETE", "subscriptions/" + f.stripe_subscription).catch(console.error);
    await alert(`${a.label} bank payment of ${amt} FAILED, check Stripe`, token);
  } else if (ev.type === "invoice.payment_failed") {
    await alert(`${a.label} monthly payment of ${amt} FAILED, check Stripe`, token);
  }
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!KEY) return json({ status: "error", error: "not configured" }, 500);
  const sig = req.headers.get("stripe-signature");
  try {
    if (sig) return await webhook(req, sig);
    const { token } = await req.json().catch(() => ({}));
    if (typeof token !== "string" || token.length > 64) return json({ status: "invalid" });
    return await checkout(token);
  } catch (e) {
    console.error(e);
    return json({ status: "error" }, 500);
  }
});
