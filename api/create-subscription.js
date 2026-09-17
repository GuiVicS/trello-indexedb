import { stripe, supabaseAdmin, getUserFromRequest } from "./_lib.js";

// Cria (ou reaproveita) um customer no Stripe para o usuário logado e abre uma
// assinatura em status "incomplete", retornando o client_secret do PaymentIntent
// para o checkout transparente (Stripe Elements) confirmar o cartão no navegador.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "não autenticado" });

  try {
    const { data: profile } = await supabaseAdmin.from("profiles").select("*").eq("id", user.id).single();
    const { data: existingSub } = await supabaseAdmin
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    let customerId = existingSub?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: profile?.name || undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.STRIPE_PRICE_ID_MONTHLY }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
      metadata: { supabase_user_id: user.id },
    });

    await supabaseAdmin.from("subscriptions").upsert({
      user_id: user.id,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      price_id: process.env.STRIPE_PRICE_ID_MONTHLY,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    const clientSecret = subscription.latest_invoice?.payment_intent?.client_secret;
    if (!clientSecret) return res.status(500).json({ error: "não foi possível iniciar o pagamento" });

    return res.status(200).json({ clientSecret, subscriptionId: subscription.id });
  } catch (err) {
    console.error("create-subscription error:", err);
    return res.status(500).json({ error: err.message || "erro ao criar assinatura" });
  }
}
