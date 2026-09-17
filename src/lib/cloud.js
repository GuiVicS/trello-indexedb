import { supabase, supabaseConfigured } from "./supabaseClient.js";

// ================= estado de sessão =================
let currentSession = null;
let currentSubscription = null; // linha da tabela `subscriptions`, ou null
let currentIsSuperadmin = false;
const listeners = new Set();

function notify() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

export function onCloudChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function cloudAvailable() { return supabaseConfigured; }
export function getSession() { return currentSession; }
export function getSubscription() { return currentSubscription; }
export function isSuperadmin() { return currentIsSuperadmin; }
export function isCloudActive() {
  return Boolean(currentSession && currentSubscription && ["active", "trialing"].includes(currentSubscription.status));
}

export async function initCloud() {
  if (!supabaseConfigured) return;
  const { data } = await supabase.auth.getSession();
  currentSession = data?.session || null;
  if (currentSession) await refreshSubscription();
  supabase.auth.onAuthStateChange(async (_event, session) => {
    currentSession = session;
    await refreshSubscription();
    notify();
  });
  notify();
}

async function refreshSubscription() {
  if (!currentSession) { currentSubscription = null; currentIsSuperadmin = false; return; }
  const { data } = await supabase.from("subscriptions").select("*").eq("user_id", currentSession.user.id).maybeSingle();
  currentSubscription = data || null;
  const { data: profile } = await supabase.from("profiles").select("is_superadmin").eq("id", currentSession.user.id).maybeSingle();
  currentIsSuperadmin = Boolean(profile?.is_superadmin);
}

// ================= autenticação =================
export async function signUpCloud({ name, email, phone, cpf, password }) {
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { name, phone, cpf } },
  });
  if (error) throw error;
  currentSession = data.session || null;
  if (currentSession) await refreshSubscription();
  notify();
  return data;
}

export async function signInCloud({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  currentSession = data.session;
  await refreshSubscription();
  notify();
  return data;
}

export async function signOutCloud() {
  await supabase.auth.signOut();
  currentSession = null;
  currentSubscription = null;
  notify();
}

// ================= checkout (Stripe Elements embutido) =================
async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (currentSession) headers.Authorization = `Bearer ${currentSession.access_token}`;
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
  return body;
}

export async function createSubscriptionIntent() {
  return apiFetch("/api/create-subscription", { method: "POST" });
}

export async function refreshAfterCheckout() {
  await refreshSubscription();
  notify();
}

// ================= migração IndexedDB -> nuvem =================
// db: objeto com { dbGetAll } injetado pelo main.js pra não duplicar a camada IndexedDB aqui.
export async function migrateLocalToCloud(db) {
  if (!currentSession) throw new Error("Faça login antes de migrar seus dados.");
  const userId = currentSession.user.id;
  const workspaces = await db.dbGetAll("workspaces");
  const tasks = await db.dbGetAll("tasks");

  for (const ws of workspaces) {
    await supabase.from("cloud_workspaces").upsert({
      id: ws.id, user_id: userId, name: ws.name,
      labels: ws.labels || [], statuses: ws.statuses || [],
      updated_at: new Date().toISOString(),
    });
  }
  for (const t of tasks) {
    await pushTaskToCloud(t, { silent: true });
  }
  return { workspaces: workspaces.length, tasks: tasks.length };
}

// ================= sync incremental (chamado a cada save local) =================
export async function pushWorkspaceToCloud(ws) {
  if (!isCloudActive() || !navigator.onLine) return;
  const userId = currentSession.user.id;
  try {
    await supabase.from("cloud_workspaces").upsert({
      id: ws.id, user_id: userId, name: ws.name,
      labels: ws.labels || [], statuses: ws.statuses || [],
      updated_at: new Date().toISOString(),
    });
  } catch (e) { console.warn("Falha ao sincronizar espaço com a nuvem:", e.message); }
}

export async function pushTaskToCloud(task, { silent } = {}) {
  if (!silent && (!isCloudActive() || !navigator.onLine)) return;
  if (!currentSession) return;
  const userId = currentSession.user.id;
  try {
    await supabase.from("cloud_tasks").upsert({
      id: task.id, workspace_id: task.workspaceId, user_id: userId,
      title: task.title, status: task.status, priority: task.priority, due_date: task.dueDate || null,
      tags: task.tags || [], content: task.content || [], checklist: task.checklist || [],
      attachments: (task.attachments || []).map(({ id, name, type }) => ({ id, name, type })), // sem blob: metadados só
      activity: task.activity || [],
      updated_at: new Date().toISOString(),
    });
  } catch (e) { console.warn("Falha ao sincronizar tarefa com a nuvem:", e.message); }
}

export async function deleteTaskFromCloud(taskId) {
  if (!isCloudActive() || !navigator.onLine || !currentSession) return;
  try { await supabase.from("cloud_tasks").delete().eq("id", taskId); } catch (e) { console.warn(e.message); }
}

// ================= puxar mudanças da nuvem (last-write-wins por updated_at) =================
export async function pullCloudChanges(db) {
  if (!isCloudActive() || !navigator.onLine) return { workspaces: 0, tasks: 0 };
  const userId = currentSession.user.id;
  const { data: remoteWs } = await supabase.from("cloud_workspaces").select("*").eq("user_id", userId);
  const { data: remoteTasks } = await supabase.from("cloud_tasks").select("*").eq("user_id", userId);

  let wsCount = 0, taskCount = 0;
  for (const rw of remoteWs || []) {
    const local = await db.dbGet("workspaces", rw.id);
    const remoteUpdated = new Date(rw.updated_at).getTime();
    if (!local || !local.updatedAt || remoteUpdated > local.updatedAt) {
      await db.dbPut("workspaces", { id: rw.id, name: rw.name, labels: rw.labels, statuses: rw.statuses, createdAt: local?.createdAt || Date.now(), updatedAt: remoteUpdated });
      wsCount++;
    }
  }
  for (const rt of remoteTasks || []) {
    const local = await db.dbGet("tasks", rt.id);
    const remoteUpdated = new Date(rt.updated_at).getTime();
    if (!local || remoteUpdated > local.updatedAt) {
      await db.dbPut("tasks", {
        id: rt.id, workspaceId: rt.workspace_id, title: rt.title, status: rt.status, priority: rt.priority,
        dueDate: rt.due_date || "", tags: rt.tags || [], content: rt.content || [], checklist: rt.checklist || [],
        attachments: local?.attachments || [], // anexos com blob local não são sobrescritos pela nuvem
        activity: rt.activity || [], createdAt: local?.createdAt || remoteUpdated, updatedAt: remoteUpdated,
      });
      taskCount++;
    }
  }
  return { workspaces: wsCount, tasks: taskCount };
}

export function setupOnlineSync(db) {
  window.addEventListener("online", async () => {
    if (!isCloudActive()) return;
    try { await pullCloudChanges(db); } catch (e) { console.warn("Sync ao voltar online falhou:", e.message); }
  });
}
