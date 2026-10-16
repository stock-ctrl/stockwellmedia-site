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
  "invoice.paid",
  "customer.subscription.deleted",
];
let eventsChecked = false;
// endpoints created before an event was added to EVENTS get it added here (once per warm instance)
async function ensureEvents() {
  if (eventsChecked) return;
  const eps = await stripe("GET", "webhook_endpoints?limit=100");
  const ep = eps.data.find((e: { url: string }) => e.url === SELF);
  if (ep && EVENTS.some((e) => !ep.enabled_events.includes(e))) {
    await stripe("POST", "webhook_endpoints/" + ep.id, { enabled_events: Object.fromEntries(EVENTS.map((e, i) => [i, e])) });
  }
  eventsChecked = true;
}
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
  await ensureEvents();

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
  // prepay covers N months from the first billing date, then the plan rolls into monthly billing on the saved method
  const prepaid = monthly ? 0 : parseInt(pay.id, 10) || 0;
  const first = new Date(firstBillingDate(new Date(a.signed_at), t.launch_days) * 1000);
  const start = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + prepaid, 1, 15) / 1000;
  const startText = new Date(start * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", ...(prepaid ? { year: "numeric" } : {}), timeZone: "America/Chicago" });
  // Build fee (plus prepay) is a one-time checkout that also saves the payment method; the webhook starts the
  // $200/mo subscription from that saved method (see startMonthly), right away on monthly or after the prepaid months.
  const total = cents(build.price) + (monthly ? 0 : cents(pay.price));
  // sandbox only: test- agreements get a customer on a Stripe test clock so months can be fast-forwarded
  let testCustomer: string | undefined, testClock: string | undefined;
  if (MODE === "test" && token.startsWith("test-")) {
    const clock = await stripe("POST", "test_helpers/test_clocks", { frozen_time: Math.floor(Date.now() / 1000), name: token });
    const cus = await stripe("POST", "customers", { name: client, test_clock: clock.id, metadata: { token } });
    testCustomer = cus.id; testClock = clock.id;
    await sql`insert into stockwell.secrets(key, value) values (${"test_clock:" + token}, ${clock.id})
              on conflict (key) do update set value = excluded.value`;
  }
  const session = await stripe("POST", "checkout/sessions", {
    ...common,
    mode: "payment",
    ...(testCustomer ? { customer: testCustomer } : { customer_creation: "always" }),
    line_items: {
      0: buildLine,
      ...(monthly ? {} : {
        1: { quantity: 1, price_data: { currency: "usd", unit_amount: cents(pay.price), product_data: { name: `Website plan: ${pay.name}` } } },
      }),
    },
    metadata: { token, monthly_start: start },
    custom_text: {
      submit: {
        message: monthly
          ? `Then ${usd(cents(t.monthly))} a month for the website plan, charged automatically on the 1st starting ${startText}. ${client} website agreement ${token}.`
          : `After the ${prepaid} prepaid months, ${usd(cents(t.monthly))} a month starting ${startText}, charged automatically unless you cancel or prepay again. ${client} website agreement ${token}.`,
      },
    },
    payment_intent_data: {
      metadata: { token, client },
      description: monthly ? `${client} website build` : `${client} website build and ${pay.name}`,
      setup_future_usage: "off_session",
    },
    invoice_creation: { enabled: true },
  });
  await sql`update stockwell.agreements set stripe_session = ${session.id}, pay_amount_cents = ${total} where token = ${token}`;
  return json({ status: "ok", url: session.url, ...(testClock ? { test_clock: testClock } : {}) });
}

// Past-due monthly plan: setup-mode checkout to save a new card or bank account; the webhook makes it the
// subscription's default and retries the open bill.
async function updatePayment(token: string) {
  const [a] = await sql`select pay_status, stripe_customer, stripe_subscription from stockwell.agreements where token = ${token}`;
  if (!a || a.pay_status !== "past_due" || !a.stripe_customer || !a.stripe_subscription) return json({ status: "invalid" });
  const sub = await stripe("GET", "subscriptions/" + a.stripe_subscription);
  if (sub.status === "canceled") return json({ status: "canceled" });
  await ensureEvents();
  const session = await stripe("POST", "checkout/sessions", {
    mode: "setup",
    customer: a.stripe_customer,
    currency: "usd",
    payment_method_types: { 0: "us_bank_account", 1: "card" },
    payment_method_options: { us_bank_account: { verification_method: "automatic" } },
    success_url: SITE + token + "&updated=1",
    cancel_url: SITE + token,
    client_reference_id: token,
    metadata: { token, purpose: "update_payment" },
    custom_text: { submit: { message: "We'll use this for your website plan from now on and retry the payment that didn't go through." } },
  });
  return json({ status: "ok", url: session.url });
}

// sandbox only: move a test clock forward and report what Stripe billed
async function testHelper(token: string, body: Record<string, any>) {
  if (MODE !== "test" || !token.startsWith("test-")) return json({ status: "invalid" });
  const [row] = await sql`select value from stockwell.secrets where key = ${"test_clock:" + token}`;
  const clock = String(row?.value || "");
  if (!clock.startsWith("clock_")) return json({ status: "invalid" });
  if (body.action === "test_advance") {
    await stripe("POST", `test_helpers/test_clocks/${clock}/advance`, { frozen_time: Number(body.to) });
    for (let i = 0; i < 30; i++) {
      const c = await stripe("GET", `test_helpers/test_clocks/${clock}`);
      if (c.status === "ready") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const [a] = await sql`select pay_status, stripe_customer, stripe_subscription from stockwell.agreements where token = ${token}`;
  if (body.action === "test_failing_card" && a?.stripe_subscription) {
    // Stripe test card that saves fine but declines every charge
    const pm = await stripe("POST", "payment_methods/pm_card_chargeCustomerFail/attach", { customer: a.stripe_customer });
    await stripe("POST", `subscriptions/${a.stripe_subscription}`, { default_payment_method: pm.id });
  }
  const c = await stripe("GET", `test_helpers/test_clocks/${clock}`);
  const inv = a?.stripe_customer ? await stripe("GET", `invoices?customer=${a.stripe_customer}&limit=20`) : { data: [] };
  const sub = a?.stripe_subscription ? await stripe("GET", `subscriptions/${a.stripe_subscription}`) : null;
  const pis = a?.stripe_customer ? await stripe("GET", `payment_intents?customer=${a.stripe_customer}&limit=20`) : { data: [] };
  return json({
    status: "ok", clock_time: new Date(c.frozen_time * 1000).toISOString(), clock_status: c.status, pay_status: a?.pay_status,
    subscription: sub && { status: sub.status, next_bill: sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end },
    invoices: inv.data.map((i: any) => ({ amount: i.amount_due, status: i.status, date: new Date(i.created * 1000).toISOString().slice(0, 10), reason: i.billing_reason })),
    payments: pis.data.map((p: any) => ({ amount: p.amount, status: p.status, desc: p.description })),
  });
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
  // invoices carry the subscription's metadata under parent.subscription_details (older API: subscription_details)
  const token: string | undefined = o.metadata?.token || o.client_reference_id ||
    o.parent?.subscription_details?.metadata?.token || o.subscription_details?.metadata?.token;
  if (!token) return json({ ok: true, skipped: true });
  const [a] = await sql`select label, pay_status, pay_amount_cents from stockwell.agreements where token = ${token}`;
  if (!a) return json({ ok: true, skipped: true });
  // belt and braces: re-read checkout sessions straight from Stripe instead of trusting the event body
  if (ev.type.startsWith("checkout.session.")) Object.assign(o, await stripe("GET", "checkout/sessions/" + o.id));
  const amt = usd(o.amount_total ?? o.amount_due ?? 0);
  if (ev.type === "checkout.session.completed" && o.mode === "setup" && o.metadata?.purpose === "update_payment") {
    const [r] = await sql`select stripe_subscription from stockwell.agreements where token = ${token}`;
    const si = await stripe("GET", "setup_intents/" + o.setup_intent);
    await stripe("POST", "subscriptions/" + r.stripe_subscription, { default_payment_method: si.payment_method });
    const open = await stripe("GET", `invoices?subscription=${r.stripe_subscription}&status=open&limit=10`);
    let ok = true;
    for (const inv of open.data) {
      try { await stripe("POST", `invoices/${inv.id}/pay`, { payment_method: si.payment_method }); }
      catch (e) { ok = false; console.error(e); }
    }
    // invoice.paid flips pay_status back to paid; a bank payment shows up there once it clears
    if (!ok) await alert(`${a.label} updated their payment method but the retry failed, check Stripe`, token);
    return json({ ok: true });
  }
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
      const day = new Date(Number(o.metadata.monthly_start) * 1000)
        .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
      try { await startMonthly(o, token); note = `, monthly plan starts ${day}`; }
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
    await sql`update stockwell.agreements set pay_status = 'past_due' where token = ${token}`;
    // Stripe retries a declined bill several times; only text on the first try
    if ((o.attempt_count ?? 1) <= 1) {
      await alert(`${a.label} monthly payment of ${amt} FAILED. Stripe will retry, and their agreement page now asks them to update their card`, token);
    }
  } else if (ev.type === "customer.subscription.deleted") {
    const why = o.cancellation_details?.reason === "payment_failed" ? " because every payment retry failed" : "";
    await alert(`${a.label} monthly plan was CANCELED${why}. Restart it in Stripe if they're staying`, token);
  } else if (ev.type === "invoice.paid") {
    if (a.pay_status === "past_due" && o.amount_paid > 0) {
      await sql`update stockwell.agreements set pay_status = 'paid' where token = ${token}`;
      await alert(`${a.label} caught up: ${usd(o.amount_paid)} monthly payment went through`, token);
    }
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
    const body = await req.json().catch(() => ({}));
    const token = body.token;
    if (typeof token !== "string" || token.length > 64) return json({ status: "invalid" });
    if (["test_advance", "test_status", "test_failing_card"].includes(body.action)) return await testHelper(token, body);
    if (body.action === "update_payment") return await updatePayment(token);
    return await checkout(token);
  } catch (e) {
    console.error(e);
    return json({ status: "error" }, 500);
  }
});
