import { supabaseAdmin, getUserFromRequest } from "../_lib.js";

// Lista todas as assinaturas para a tela de superadmin. Só funciona se o usuário
// autenticado tiver profiles.is_superadmin = true — checado aqui no servidor com a
// service role, nunca liberado via RLS direto para o cliente.
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "não autenticado" });

  const { data: profile } = await supabaseAdmin.from("profiles").select("is_superadmin").eq("id", user.id).single();
  if (!profile?.is_superadmin) return res.status(403).json({ error: "acesso restrito a administradores" });

  const { data: subs, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*, profiles:user_id(name, email, phone, cpf)")
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ subscriptions: subs });
}
