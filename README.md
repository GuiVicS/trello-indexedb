# Tarefas — app de tarefas local (Trello + Notion, offline via IndexedDB)

Stack: **Vite + vite-plugin-pwa**. Todos os dados ficam no IndexedDB do navegador
de quem acessa — não há backend, não há login, não há nuvem. 

## Rodar localmente

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173`. O plugin de PWA fica ativo até em modo dev
(`devOptions.enabled: true`), então já dá pra testar o "Instalar app" e o
funcionamento offline sem precisar buildar.

## Testar o build de produção antes de subir

```bash
npm run build
npm run preview
```

## Deploy no Vercel

**Opção A — pelo painel (recomendado):**
1. Suba esta pasta para um repositório no GitHub/GitLab/Bitbucket.
2. Em vercel.com → "Add New Project" → importe o repositório.
3. O Vercel detecta o preset **Vite** automaticamente:
   - Build Command: `vite build` (ou `npm run build`)
   - Output Directory: `dist`
   - Install Command: `npm install`
4. Deploy. Pronto — `manifest.webmanifest`, `sw.js` e os ícones já saem
   corretos, com os headers de cache certos (definidos em `vercel.json`).

**Opção B — via CLI, sem git:**
```bash
npm install -g vercel
vercel        # deploy de preview
vercel --prod # deploy de produção
```

## Por que o PWA não funcionava antes

A versão anterior era um único arquivo HTML com `manifest.json` e `sw.js`
escritos à mão, com uma lista fixa de arquivos pra cachear e paths relativos.
Isso quebra fácil dependendo de como a hospedagem serve os arquivos (headers
de cache, escopo do service worker, versionamento do cache a cada mudança).

Agora o **vite-plugin-pwa** gera o manifest e o service worker no build,
com hash nos arquivos, pré-cache automático de tudo que o app precisa, e
atualização automática (`registerType: "autoUpdate"`) — cada novo deploy
invalida o cache antigo sozinho. O `vercel.json` garante que o `sw.js` e o
`manifest.webmanifest` nunca fiquem presos em cache do CDN.

## Estrutura

```
index.html          → entrada do app
src/main.js          → toda a lógica (workspaces, tarefas, quadro, tabela,
                        calendário, relatórios, busca Ctrl+K) — IndexedDB puro
src/style.css        → estilos
public/icons/        → ícones do PWA (192, 512, apple-touch-icon, svg)
vite.config.js        → configuração do Vite + vite-plugin-pwa
vercel.json           → headers de cache do sw.js / manifest
```

## Próximos passos sugeridos

- Exportar/importar backup em JSON (mitiga perda de dados do IndexedDB).
- Ligar o botão "Gerar relatório" a uma chamada real da API do Claude
  (o resumo hoje é gerado localmente por um template simples — o ponto de
  entrada já está marcado em `generateReport()` dentro de `src/main.js`).
