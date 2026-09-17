(function () {
  "use strict";

  /* ================= utils ================= */
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const todayStr = () => { const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
  const fmtDate = (iso) => { if(!iso) return ""; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };
  const fmtDateTime = (ts) => { const d = new Date(ts); return d.toLocaleDateString("pt-BR")+" "+d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); };
  const icons = () => { try { lucide.createIcons(); } catch(e) {} };

  const STATUS = [
    { id: "todo", label: "A Fazer", color: "#6B6659" },
    { id: "doing", label: "Em Andamento", color: "#C9820E" },
    { id: "done", label: "Concluído", color: "#2E8B57" },
  ];
  const PRIORITY = [
    { id: "none", label: "Sem prioridade" },
    { id: "baixa", label: "Baixa" },
    { id: "media", label: "Média" },
    { id: "alta", label: "Alta" },
    { id: "urgente", label: "Urgente" },
  ];
  const GROUPABLE = [
    { id: "status", label: "Status", options: STATUS },
    { id: "priority", label: "Prioridade", options: PRIORITY.map(p => ({ id: p.id, label: p.label, color: "var(--text-dim)" })) },
  ];

  /* ================= IndexedDB ================= */
  const DB_NAME = "tarefasAppDB";
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("workspaces")) db.createObjectStore("workspaces", { keyPath: "id" });
        if (!db.objectStoreNames.contains("tasks")) {
          const store = db.createObjectStore("tasks", { keyPath: "id" });
          store.createIndex("workspaceId", "workspaceId", { unique: false });
        }
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function tx(name, mode) { const db = await openDB(); return db.transaction(name, mode).objectStore(name); }
  async function dbGetAll(store) { const s = await tx(store, "readonly"); return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
  async function dbGetByIndex(store, index, value) { const s = await tx(store, "readonly"); return new Promise((res, rej) => { const r = s.index(index).getAll(value); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
  async function dbPut(store, obj) { const s = await tx(store, "readwrite"); return new Promise((res, rej) => { const r = s.put(obj); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  async function dbDelete(store, id) { const s = await tx(store, "readwrite"); return new Promise((res, rej) => { const r = s.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  async function dbGetMeta(key, fallback) { try { const s = await tx("meta","readonly"); return await new Promise((res,rej)=>{ const r=s.get(key); r.onsuccess=()=>res(r.result?r.result.value:fallback); r.onerror=()=>rej(r.error); }); } catch(e){ return fallback; } }
  async function dbPutMeta(key, value) { try { const s = await tx("meta","readwrite"); await new Promise((res,rej)=>{ const r=s.put({key,value}); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); } catch(e){} }

  // pede armazenamento persistente pra reduzir chance de o navegador limpar os dados sozinho
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(()=>{}); }

  /* ================= state ================= */
  const state = {
    workspaces: [],
    activeWorkspaceId: null,
    tasks: [],
    view: "board",
    groupBy: "status",
    calMonth: new Date(todayStr()).getMonth(),
    calYear: new Date(todayStr()).getFullYear(),
    openTaskId: null,
    theme: "light",
    dragging: null,
  };

  function activeWorkspace() { return state.workspaces.find(w => w.id === state.activeWorkspaceId) || null; }
  function findTask(id) { return state.tasks.find(t => t.id === id) || null; }
  function logActivity(task, text) { task.activity = task.activity || []; task.activity.unshift({ id: uid(), ts: Date.now(), text }); }

  function makeWorkspace(name) { return { id: uid(), name: name || "Meu espaço", labels: [], createdAt: Date.now() }; }
  function makeTask(workspaceId, title) {
    return {
      id: uid(), workspaceId, title: title || "Nova tarefa",
      status: "todo", priority: "none", dueDate: "",
      content: [{ id: uid(), type: "paragraph", text: "" }],
      checklist: [], attachments: [], activity: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
  }

  async function loadWorkspaceTasks() {
    state.tasks = state.activeWorkspaceId ? await dbGetByIndex("tasks", "workspaceId", state.activeWorkspaceId) : [];
  }

  async function saveTask(task) { task.updatedAt = Date.now(); await dbPut("tasks", task); }

  /* ================= seed ================= */
  async function seedIfEmpty() {
    const ws = await dbGetAll("workspaces");
    if (ws.length > 0) { state.workspaces = ws; return; }
    const workspace = makeWorkspace("Trabalho");
    await dbPut("workspaces", workspace);
    const t1 = makeTask(workspace.id, "Arraste os cartões entre as colunas");
    t1.content = [{ id: uid(), type: "paragraph", text: "Clique num cartão para abrir os detalhes: propriedades, checklist, anexos e histórico." }];
    t1.priority = "media";
    t1.checklist = [{ id: uid(), text: "Testar o modo escuro", done: false }, { id: uid(), text: "Criar um novo espaço de trabalho", done: false }];
    const t2 = makeTask(workspace.id, "Tudo fica salvo no seu navegador (IndexedDB)");
    t2.content = [{ id: uid(), type: "paragraph", text: "Os dados continuam aqui mesmo se você fechar a aba — use Ctrl+K para buscar rapidamente." }];
    t2.status = "doing"; t2.priority = "baixa";
    const t3 = makeTask(workspace.id, "Exemplo concluído");
    t3.status = "done"; t3.priority = "alta";
    for (const t of [t1, t2, t3]) { logActivity(t, "Tarefa criada"); await dbPut("tasks", t); }
    state.workspaces = [workspace];
  }

  /* ================= render: shell ================= */
  function renderSidebar() {
    const menu = $("#workspaceMenu");
    menu.innerHTML = state.workspaces.map(w => `
      <div class="ws-item ${w.id === state.activeWorkspaceId ? "active" : ""}" data-action="select-ws" data-id="${w.id}">
        <i data-lucide="briefcase"></i><span>${esc(w.name)}</span>
        <button class="ws-del" data-action="delete-ws" data-id="${w.id}" title="Excluir espaço"><i data-lucide="trash-2"></i></button>
      </div>`).join("") + `<div class="ws-item ws-new" data-action="new-ws"><i data-lucide="plus"></i><span>Novo espaço de trabalho</span></div>`;

    const ws = activeWorkspace();
    $("#workspaceBtn .ws-name").textContent = ws ? ws.name : "Nenhum espaço";

    $$(".nav-link").forEach(a => a.classList.toggle("active", a.dataset.view === state.view));
    icons();
  }

  function renderTopbar() {
    const topbar = $("#topbar");
    const titles = { board: "Quadro", table: "Tabela", calendar: "Calendário", reports: "Relatórios" };
    let extra = "";
    if (state.view === "board") {
      extra = `<select class="group-select" id="groupBySelect">${GROUPABLE.map(g => `<option value="${g.id}" ${g.id===state.groupBy?"selected":""}>Agrupar por: ${g.label}</option>`).join("")}</select>`;
    }
    topbar.innerHTML = `
      <h1>${titles[state.view] || ""}</h1>
      ${extra}
      ${state.view !== "reports" ? `<button class="icon-btn primary" id="newTaskBtn"><i data-lucide="plus"></i> Nova tarefa</button>` : ""}
    `;
    icons();
    if ($("#groupBySelect")) $("#groupBySelect").addEventListener("change", (e) => { state.groupBy = e.target.value; renderView(); });
    if ($("#newTaskBtn")) $("#newTaskBtn").addEventListener("click", () => quickAddTask());
  }

  async function quickAddTask(status) {
    const ws = activeWorkspace();
    if (!ws) return;
    const task = makeTask(ws.id, "Nova tarefa");
    if (status) task.status = status;
    logActivity(task, "Tarefa criada");
    await saveTask(task);
    state.tasks.push(task);
    state.openTaskId = task.id;
    renderView();
    renderTaskModal();
  }

  /* ================= board view ================= */
  function renderBoard(container) {
    const ws = activeWorkspace();
    if (!ws) { container.innerHTML = emptyStateHTML(); icons(); return; }
    const group = GROUPABLE.find(g => g.id === state.groupBy);
    const wrap = document.createElement("div");
    wrap.id = "boardView";
    group.options.forEach(opt => {
      const cards = state.tasks.filter(t => (t[group.id] || (group.id === "priority" ? "none" : "todo")) === opt.id);
      const col = document.createElement("div");
      col.className = "col";
      col.dataset.groupValue = opt.id;
      col.innerHTML = `
        <div class="col-header"><span class="col-dot" style="background:${opt.color || "var(--text-dim)"}"></span>${esc(opt.label)} <span class="col-count">${cards.length}</span></div>
        <div class="col-cards" data-group-value="${opt.id}">
          ${cards.map(cardHTML).join("")}
        </div>
        <button class="col-add" data-action="add-in-col" data-value="${opt.id}"><i data-lucide="plus"></i> Adicionar cartão</button>
      `;
      wrap.appendChild(col);
    });
    container.innerHTML = "";
    container.appendChild(wrap);
    icons();
    attachBoardDragHandlers(wrap, group.id);
  }

  function cardHTML(t) {
    const overdue = t.dueDate && t.dueDate < todayStr() && t.status !== "done";
    const doneItems = (t.checklist || []).filter(c => c.done).length;
    return `
    <div class="tcard" draggable="true" data-task-id="${t.id}" data-action="open-task">
      <div class="tcard-title">${esc(t.title)}</div>
      <div class="tcard-meta">
        ${t.priority && t.priority !== "none" ? `<span class="pill pill-priority-${t.priority}">${PRIORITY.find(p=>p.id===t.priority).label}</span>` : ""}
        ${t.dueDate ? `<span class="pill pill-due ${overdue ? "overdue" : ""}"><i data-lucide="calendar" style="width:11px;height:11px"></i> ${fmtDate(t.dueDate)}</span>` : ""}
      </div>
      <div class="tcard-sub">
        ${t.checklist && t.checklist.length ? `<span><i data-lucide="check-square" style="width:12px;height:12px"></i> ${doneItems}/${t.checklist.length}</span>` : ""}
        ${t.attachments && t.attachments.length ? `<span><i data-lucide="paperclip" style="width:12px;height:12px"></i> ${t.attachments.length}</span>` : ""}
      </div>
    </div>`;
  }

  function attachBoardDragHandlers(container, groupField) {
    let draggingEl = null, draggingId = null;
    container.addEventListener("dragstart", (e) => {
      const card = e.target.closest(".tcard");
      if (!card) return;
      draggingEl = card; draggingId = card.dataset.taskId;
      card.classList.add("dragging");
    });
    container.addEventListener("dragend", () => { if (draggingEl) draggingEl.classList.remove("dragging"); draggingEl = null; });
    $$(".col-cards", container).forEach(col => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.parentElement.style.borderColor = "var(--accent)"; });
      col.addEventListener("dragleave", () => { col.parentElement.style.borderColor = "var(--border)"; });
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.parentElement.style.borderColor = "var(--border)";
        if (!draggingId) return;
        const task = findTask(draggingId);
        if (!task) return;
        const newVal = col.dataset.groupValue;
        if (task[groupField] !== newVal) {
          const group = GROUPABLE.find(g => g.id === groupField);
          logActivity(task, `${group.label} alterado para "${group.options.find(o=>o.id===newVal).label}"`);
          task[groupField] = newVal;
          await saveTask(task);
        }
        renderView();
      });
    });
  }

  /* ================= table view ================= */
  function renderTable(container) {
    const ws = activeWorkspace();
    if (!ws) { container.innerHTML = emptyStateHTML(); icons(); return; }
    const rows = state.tasks.slice().sort((a,b) => b.updatedAt - a.updatedAt);
    container.innerHTML = `
      <table class="tbl">
        <thead><tr><th>Título</th><th>Status</th><th>Prioridade</th><th>Prazo</th><th>Atualizado</th></tr></thead>
        <tbody>
          ${rows.map(t => `
            <tr data-action="open-task" data-task-id="${t.id}">
              <td>${esc(t.title)}</td>
              <td>${STATUS.find(s=>s.id===t.status)?.label || ""}</td>
              <td>${PRIORITY.find(p=>p.id===t.priority)?.label || ""}</td>
              <td>${t.dueDate ? fmtDate(t.dueDate) : "—"}</td>
              <td>${fmtDateTime(t.updatedAt)}</td>
            </tr>`).join("") || `<tr><td colspan="5" style="color:var(--text-dim)">Nenhuma tarefa ainda.</td></tr>`}
        </tbody>
      </table>`;
    icons();
  }

  /* ================= calendar view ================= */
  function renderCalendar(container) {
    const ws = activeWorkspace();
    if (!ws) { container.innerHTML = emptyStateHTML(); icons(); return; }
    const year = state.calYear, month = state.calMonth;
    const first = new Date(year, month, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthName = first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

    const byDate = {};
    state.tasks.forEach(t => { if (t.dueDate) { (byDate[t.dueDate] = byDate[t.dueDate] || []).push(t); } });

    let cells = "";
    for (let i = 0; i < startDow; i++) cells += `<div class="calday muted"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const items = byDate[iso] || [];
      cells += `<div class="calday ${iso === todayStr() ? "today" : ""}">
        <span class="daynum">${d}</span>
        ${items.slice(0,3).map(t => `<div class="calchip" data-action="open-task" data-task-id="${t.id}">${esc(t.title)}</div>`).join("")}
        ${items.length > 3 ? `<div class="calchip">+${items.length - 3}</div>` : ""}
      </div>`;
    }
    container.innerHTML = `
      <div id="calHeader">
        <button class="icon-btn" id="calPrev"><i data-lucide="chevron-left"></i></button>
        <h2>${monthName}</h2>
        <button class="icon-btn" id="calNext"><i data-lucide="chevron-right"></i></button>
      </div>
      <div class="calgrid">
        ${["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"].map(d => `<div class="dow">${d}</div>`).join("")}
        ${cells}
      </div>`;
    icons();
    $("#calPrev").addEventListener("click", () => { state.calMonth--; if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; } renderView(); });
    $("#calNext").addEventListener("click", () => { state.calMonth++; if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; } renderView(); });
  }

  /* ================= reports view ================= */
  function renderReports(container) {
    const ws = activeWorkspace();
    if (!ws) { container.innerHTML = emptyStateHTML(); icons(); return; }
    const from = state.reportFrom || (() => { const d = new Date(); d.setDate(d.getDate()-30); return d.toISOString().slice(0,10); })();
    const to = state.reportTo || todayStr();
    container.innerHTML = `
      <div class="report-controls">
        <label>De <input type="date" id="repFrom" value="${from}"></label>
        <label>Até <input type="date" id="repTo" value="${to}"></label>
        <button class="icon-btn primary" id="genReportBtn"><i data-lucide="sparkles"></i> Gerar relatório</button>
        <button class="icon-btn" id="printReportBtn"><i data-lucide="download"></i> Exportar PDF</button>
      </div>
      <div id="reportOutput" class="hidden"></div>
    `;
    icons();
    $("#genReportBtn").addEventListener("click", () => {
      state.reportFrom = $("#repFrom").value;
      state.reportTo = $("#repTo").value;
      generateReport(state.reportFrom, state.reportTo);
    });
    $("#printReportBtn").addEventListener("click", () => window.print());
    if (state.lastReportHTML) { $("#reportOutput").innerHTML = state.lastReportHTML; $("#reportOutput").classList.remove("hidden"); }
  }

  function generateReport(from, to) {
    const inRange = state.tasks.filter(t => {
      const d = (t.dueDate || t.updatedAt && new Date(t.updatedAt).toISOString().slice(0,10));
      return d >= from && d <= to;
    });
    const done = inRange.filter(t => t.status === "done");
    const doing = inRange.filter(t => t.status === "doing");
    const overdue = inRange.filter(t => t.dueDate && t.dueDate < todayStr() && t.status !== "done");
    const todo = inRange.filter(t => t.status === "todo");

    const html = `
      <h2 style="margin-top:0">Relatório de produtividade</h2>
      <p style="color:var(--text-dim)">Período: ${fmtDate(from)} a ${fmtDate(to)} — gerado localmente a partir dos dados do espaço "${esc(activeWorkspace().name)}".</p>
      <div class="report-section">
        <h3>Resumo executivo</h3>
        <p>No período selecionado, ${inRange.length} tarefa(s) tiveram atividade. ${done.length} foram concluídas, ${doing.length} seguem em andamento e ${overdue.length} estão atrasadas. ${overdue.length > 0 ? "Recomenda-se priorizar os itens atrasados listados abaixo." : "Não há itens atrasados no período — bom ritmo."}</p>
      </div>
      <div class="report-metrics">
        <div class="metric"><div class="num">${inRange.length}</div><div class="lbl">Total</div></div>
        <div class="metric"><div class="num">${done.length}</div><div class="lbl">Concluídas</div></div>
        <div class="metric"><div class="num">${doing.length}</div><div class="lbl">Em andamento</div></div>
        <div class="metric"><div class="num">${overdue.length}</div><div class="lbl">Atrasadas</div></div>
      </div>
      <div class="report-section">
        <h3>Concluído</h3>
        ${done.length ? `<ul>${done.map(t => `<li>${esc(t.title)}</li>`).join("")}</ul>` : `<p style="color:var(--text-dim)">Nenhuma tarefa concluída no período.</p>`}
      </div>
      <div class="report-section">
        <h3>Em andamento</h3>
        ${doing.length ? `<ul>${doing.map(t => `<li>${esc(t.title)}${t.dueDate ? " — prazo " + fmtDate(t.dueDate) : ""}</li>`).join("")}</ul>` : `<p style="color:var(--text-dim)">Nada em andamento no período.</p>`}
      </div>
      <div class="report-section">
        <h3>Atrasado</h3>
        ${overdue.length ? `<ul>${overdue.map(t => `<li>${esc(t.title)} — prazo era ${fmtDate(t.dueDate)}</li>`).join("")}</ul>` : `<p style="color:var(--text-dim)">Nenhum item atrasado.</p>`}
      </div>
      <div class="report-section">
        <h3>A fazer</h3>
        ${todo.length ? `<ul>${todo.map(t => `<li>${esc(t.title)}</li>`).join("")}</ul>` : `<p style="color:var(--text-dim)">Sem itens pendentes no período.</p>`}
      </div>
      <p style="color:var(--text-dim);font-size:11.5px;margin-top:20px">Este resumo foi montado localmente com um modelo de texto simples. Para um resumo redigido por IA, conecte aqui a chamada à API do Claude usando estes mesmos dados como entrada.</p>
    `;
    state.lastReportHTML = html;
    $("#reportOutput").innerHTML = html;
    $("#reportOutput").classList.remove("hidden");
  }

  function emptyStateHTML() {
    return `<div class="empty"><i data-lucide="inbox" style="width:40px;height:40px"></i><p>Crie um espaço de trabalho para começar.</p></div>`;
  }

  function renderView() {
    const container = $("#viewArea");
    renderTopbar();
    if (state.view === "board") renderBoard(container);
    else if (state.view === "table") renderTable(container);
    else if (state.view === "calendar") renderCalendar(container);
    else if (state.view === "reports") renderReports(container);
  }

  /* ================= task modal ================= */
  function renderTaskModal() {
    const overlay = $("#taskOverlay");
    const task = findTask(state.openTaskId);
    if (!task) { overlay.classList.add("hidden"); overlay.innerHTML = ""; return; }
    overlay.classList.remove("hidden");
    overlay.innerHTML = `
      <div id="taskModal">
        <div class="modal-top">
          <input id="tmTitle" value="${esc(task.title)}">
          <button class="icon-btn" data-action="close-task"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-grid">
          <div>
            <div class="field-label">Conteúdo</div>
            <div id="blockEditor">${task.content.map(blockHTML).join("")}</div>
            <div class="add-block-row">
              <button data-action="add-block" data-type="paragraph"><i data-lucide="text"></i> Texto</button>
              <button data-action="add-block" data-type="heading"><i data-lucide="heading"></i> Título</button>
              <button data-action="add-block" data-type="todo"><i data-lucide="check-square"></i> Checklist item</button>
            </div>

            <div class="field-label">Checklist rápida</div>
            <div class="checklist-items">
              ${(task.checklist||[]).map(c => `
                <div class="checklist-item">
                  <input type="checkbox" data-action="toggle-check" data-item-id="${c.id}" ${c.done?"checked":""}>
                  <span class="${c.done?"done":""}">${esc(c.text)}</span>
                  <button class="icon-btn" data-action="delete-check" data-item-id="${c.id}"><i data-lucide="x"></i></button>
                </div>`).join("")}
            </div>
            <form class="inline-form" id="checklistForm"><input placeholder="Adicionar item..." id="checklistInput"><button type="submit"><i data-lucide="plus"></i></button></form>

            <div class="field-label">Anexos</div>
            <div class="attachments">
              ${(task.attachments||[]).map(a => `
                <div class="attachment" title="${esc(a.name)}">
                  ${a.blob && a.type && a.type.startsWith("image/") ? `<img src="${a.url}">` : `<i data-lucide="file"></i>`}
                  <button class="att-del" data-action="delete-attachment" data-att-id="${a.id}"><i data-lucide="x" style="width:10px;height:10px"></i></button>
                </div>`).join("")}
              <div class="attachment-add" data-action="add-attachment"><i data-lucide="plus"></i></div>
            </div>

            <div class="field-label">Histórico de atividade</div>
            <div class="activity-list">
              ${(task.activity||[]).map(a => `<div class="activity-item"><span class="ts">${fmtDateTime(a.ts)}</span>${esc(a.text)}</div>`).join("") || `<div class="activity-item">Sem atividade registrada.</div>`}
            </div>
          </div>

          <div class="side-field">
            <div class="field-label">Status</div>
            <select id="tmStatus">${STATUS.map(s => `<option value="${s.id}" ${s.id===task.status?"selected":""}>${s.label}</option>`).join("")}</select>
            <div class="field-label">Prioridade</div>
            <select id="tmPriority">${PRIORITY.map(p => `<option value="${p.id}" ${p.id===task.priority?"selected":""}>${p.label}</option>`).join("")}</select>
            <div class="field-label">Prazo</div>
            <input type="date" id="tmDue" value="${task.dueDate||""}">
            <button class="danger-btn" data-action="delete-task"><i data-lucide="trash-2"></i> Excluir tarefa</button>
          </div>
        </div>
      </div>`;
    icons();
    wireTaskModalEvents(task);
  }

  function blockHTML(b) {
    if (b.type === "heading") return `<div class="block-row block-heading" data-block-id="${b.id}"><textarea rows="1" data-field="text">${esc(b.text)}</textarea><button class="block-del" data-action="delete-block" data-block-id="${b.id}"><i data-lucide="x"></i></button></div>`;
    if (b.type === "todo") return `<div class="block-row block-todo" data-block-id="${b.id}"><input type="checkbox" data-field="checked" ${b.checked?"checked":""}><input type="text" data-field="text" value="${esc(b.text)}"><button class="block-del" data-action="delete-block" data-block-id="${b.id}"><i data-lucide="x"></i></button></div>`;
    return `<div class="block-row" data-block-id="${b.id}"><textarea rows="2" data-field="text">${esc(b.text)}</textarea><button class="block-del" data-action="delete-block" data-block-id="${b.id}"><i data-lucide="x"></i></button></div>`;
  }

  function wireTaskModalEvents(task) {
    $("#tmTitle").addEventListener("change", async (e) => { task.title = e.target.value.trim() || "Sem título"; await saveTask(task); renderSidebarSafe(); renderView(); });
    $("#tmStatus").addEventListener("change", async (e) => { logActivity(task, `Status alterado para "${STATUS.find(s=>s.id===e.target.value).label}"`); task.status = e.target.value; await saveTask(task); renderView(); renderTaskModal(); });
    $("#tmPriority").addEventListener("change", async (e) => { task.priority = e.target.value; await saveTask(task); renderView(); });
    $("#tmDue").addEventListener("change", async (e) => { task.dueDate = e.target.value; await saveTask(task); renderView(); });

    $$("#blockEditor .block-row").forEach(row => {
      const bid = row.dataset.blockId;
      const block = task.content.find(b => b.id === bid);
      row.querySelectorAll("[data-field]").forEach(input => {
        const ev = input.type === "checkbox" ? "change" : "input";
        input.addEventListener(ev, async () => {
          if (input.dataset.field === "checked") block.checked = input.checked;
          else block.text = input.value;
          await saveTask(task);
        });
      });
    });

    $("#checklistForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("#checklistInput");
      const text = input.value.trim();
      if (!text) return;
      task.checklist = task.checklist || [];
      task.checklist.push({ id: uid(), text, done: false });
      await saveTask(task);
      renderView(); renderTaskModal();
    });

    $("#hiddenFileInput").onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        const buf = await f.arrayBuffer();
        const blob = new Blob([buf], { type: f.type });
        const att = { id: uid(), name: f.name, type: f.type, blob, url: URL.createObjectURL(blob) };
        task.attachments = task.attachments || [];
        task.attachments.push(att);
      }
      if (files.length) { logActivity(task, `${files.length} anexo(s) adicionado(s)`); await saveTask(task); renderView(); renderTaskModal(); }
      e.target.value = "";
    };
  }

  function renderSidebarSafe() { renderSidebar(); }

  /* ================= search (Ctrl+K) ================= */
  function openSearch() {
    $("#searchOverlay").classList.remove("hidden");
    $("#searchInput").value = "";
    renderSearchResults("");
    setTimeout(() => $("#searchInput").focus(), 0);
  }
  function closeSearch() { $("#searchOverlay").classList.add("hidden"); }
  function renderSearchResults(q) {
    const query = q.trim().toLowerCase();
    const results = !query ? state.tasks.slice(0, 8) : state.tasks.filter(t => {
      const inTitle = t.title.toLowerCase().includes(query);
      const inContent = (t.content || []).some(b => (b.text || "").toLowerCase().includes(query));
      return inTitle || inContent;
    }).slice(0, 20);
    $("#searchResults").innerHTML = results.length ? results.map(t => `
      <div class="sr-item" data-action="open-task" data-task-id="${t.id}">
        <i data-lucide="file-text"></i><span>${esc(t.title)}</span>
        <span style="margin-left:auto;color:var(--text-dim);font-size:11px">${STATUS.find(s=>s.id===t.status)?.label||""}</span>
      </div>`).join("") : `<div class="sr-empty">Nenhum resultado.</div>`;
    icons();
  }

  /* ================= workspace form ================= */
  function openWsForm() {
    const overlay = $("#wsFormOverlay");
    overlay.classList.remove("hidden");
    overlay.innerHTML = `
      <div class="simple-box">
        <h3>Novo espaço de trabalho</h3>
        <input id="wsNameInput" placeholder="Ex: Pessoal, Vendas...">
        <div class="row">
          <button data-action="cancel-ws">Cancelar</button>
          <button class="primary" data-action="confirm-ws">Criar</button>
        </div>
      </div>`;
    setTimeout(() => $("#wsNameInput").focus(), 0);
  }
  function closeWsForm() { $("#wsFormOverlay").classList.add("hidden"); $("#wsFormOverlay").innerHTML = ""; }

  /* ================= theme ================= */
  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    dbPutMeta("theme", theme);
    const btn = $("#themeToggleBtn");
    btn.innerHTML = theme === "dark" ? `<i data-lucide="sun"></i> Alternar tema` : `<i data-lucide="moon"></i> Alternar tema`;
    icons();
  }

  /* ================= global events ================= */
  function wireGlobalEvents() {
    document.body.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-action]");
      if (!t) return;
      const action = t.dataset.action;
      switch (action) {
        case "select-ws":
          state.activeWorkspaceId = t.dataset.id;
          await dbPutMeta("activeWorkspaceId", state.activeWorkspaceId);
          await loadWorkspaceTasks();
          $("#workspaceMenu").classList.add("hidden");
          renderSidebar(); renderView();
          break;
        case "delete-ws": {
          e.stopPropagation();
          if (!confirm("Excluir este espaço de trabalho e todas as suas tarefas?")) return;
          const tasksToDelete = await dbGetByIndex("tasks", "workspaceId", t.dataset.id);
          for (const tk of tasksToDelete) await dbDelete("tasks", tk.id);
          await dbDelete("workspaces", t.dataset.id);
          state.workspaces = state.workspaces.filter(w => w.id !== t.dataset.id);
          if (state.activeWorkspaceId === t.dataset.id) {
            state.activeWorkspaceId = state.workspaces[0]?.id || null;
            await dbPutMeta("activeWorkspaceId", state.activeWorkspaceId);
            await loadWorkspaceTasks();
          }
          renderSidebar(); renderView();
          break;
        }
        case "new-ws": openWsForm(); break;
        case "cancel-ws": closeWsForm(); break;
        case "confirm-ws": {
          const name = $("#wsNameInput").value.trim();
          if (!name) return;
          const ws = makeWorkspace(name);
          await dbPut("workspaces", ws);
          state.workspaces.push(ws);
          state.activeWorkspaceId = ws.id;
          await dbPutMeta("activeWorkspaceId", ws.id);
          await loadWorkspaceTasks();
          closeWsForm(); renderSidebar(); renderView();
          break;
        }
        case "add-in-col": quickAddTask(t.dataset.value); break;
        case "open-task": state.openTaskId = t.dataset.taskId; closeSearch(); renderTaskModal(); break;
        case "close-task": state.openTaskId = null; renderTaskModal(); renderView(); break;
        case "delete-task": {
          if (!confirm("Excluir esta tarefa?")) return;
          await dbDelete("tasks", state.openTaskId);
          state.tasks = state.tasks.filter(tk => tk.id !== state.openTaskId);
          state.openTaskId = null;
          renderTaskModal(); renderView();
          break;
        }
        case "add-block": {
          const task = findTask(state.openTaskId);
          const type = t.dataset.type;
          task.content.push({ id: uid(), type, text: "", checked: false });
          await saveTask(task);
          renderTaskModal();
          break;
        }
        case "delete-block": {
          const task = findTask(state.openTaskId);
          task.content = task.content.filter(b => b.id !== t.dataset.blockId);
          await saveTask(task);
          renderTaskModal();
          break;
        }
        case "delete-check": {
          const task = findTask(state.openTaskId);
          task.checklist = task.checklist.filter(c => c.id !== t.dataset.itemId);
          await saveTask(task);
          renderView(); renderTaskModal();
          break;
        }
        case "add-attachment": $("#hiddenFileInput").click(); break;
        case "delete-attachment": {
          const task = findTask(state.openTaskId);
          task.attachments = task.attachments.filter(a => a.id !== t.dataset.attId);
          await saveTask(task);
          renderView(); renderTaskModal();
          break;
        }
      }
    });

    document.body.addEventListener("change", async (e) => {
      if (e.target.matches('[data-action="toggle-check"]')) {
        const task = findTask(state.openTaskId);
        const item = task.checklist.find(c => c.id === e.target.dataset.itemId);
        if (item) item.done = e.target.checked;
        await saveTask(task);
        renderView(); renderTaskModal();
      }
    });

    $("#workspaceBtn").addEventListener("click", () => $("#workspaceMenu").classList.toggle("hidden"));
    document.addEventListener("click", (e) => { if (!e.target.closest("#workspaceSwitch")) $("#workspaceMenu").classList.add("hidden"); });

    $$(".nav-link").forEach(a => a.addEventListener("click", () => { state.view = a.dataset.view; renderSidebar(); renderView(); }));

    $("#searchOpenBtn").addEventListener("click", openSearch);
    $("#searchOverlay").addEventListener("click", (e) => { if (e.target.id === "searchOverlay") closeSearch(); });
    $("#searchInput").addEventListener("input", (e) => renderSearchResults(e.target.value));
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); }
      if (e.key === "Escape") { closeSearch(); if (state.openTaskId) { state.openTaskId = null; renderTaskModal(); renderView(); } }
    });

    $("#taskOverlay").addEventListener("click", (e) => { if (e.target.id === "taskOverlay") { state.openTaskId = null; renderTaskModal(); renderView(); } });

    $("#themeToggleBtn").addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));
  }

  /* ================= init ================= */
  async function init() {
    const savedTheme = await dbGetMeta("theme", null);
    setTheme(savedTheme || "light");
    await seedIfEmpty();
    const savedWs = await dbGetMeta("activeWorkspaceId", null);
    state.activeWorkspaceId = state.workspaces.find(w => w.id === savedWs) ? savedWs : (state.workspaces[0]?.id || null);
    await loadWorkspaceTasks();
    wireGlobalEvents();
    renderSidebar();
    renderView();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
