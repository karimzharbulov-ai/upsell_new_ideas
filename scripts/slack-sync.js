// Читает новые сообщения из Slack-канала, разбирает их Claude-ом в задачи
// и дописывает во «Входящие» доски (tasks.json в приватном репо).
// Запускается GitHub Action'ом .github/workflows/slack-sync.yml.
const { buildParsePrompt, extractJson, askClaude } = require('../docs/parse.js');

const env = (k, d) => process.env[k] || d;
const SLACK_TOKEN = env('SLACK_TOKEN');
const SLACK_CHANNEL = env('SLACK_CHANNEL', 'C0CE20KRVK8');
const SLACK_USER_ID = env('SLACK_USER_ID', '');
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY');
const DATA_REPO = env('DATA_REPO');
const DATA_TOKEN = env('DATA_TOKEN');
const DATA_PATH = 'tasks.json';

for (const [k, v] of Object.entries({ SLACK_TOKEN, ANTHROPIC_API_KEY, DATA_REPO, DATA_TOKEN })) {
  if (!v) { console.log(`Нет секрета ${k} — пропускаю синк.`); process.exit(0); }
}

async function slack(method, params) {
  const url = `https://slack.com/api/${method}?` + new URLSearchParams(params);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

function gh(path, opts = {}) {
  return fetch('https://api.github.com' + path, {
    ...opts,
    headers: { Authorization: `Bearer ${DATA_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
  });
}
async function readData() {
  const r = await gh(`/repos/${DATA_REPO}/contents/${DATA_PATH}`);
  if (!r.ok) throw new Error(`Не прочитал ${DATA_REPO}/${DATA_PATH}: ${r.status}. Сначала открой доску и подключи репо.`);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
const writeData = (data, sha, message) => gh(`/repos/${DATA_REPO}/contents/${DATA_PATH}`, {
  method: 'PUT', body: JSON.stringify({ message, sha, content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64') }),
});

async function fetchMessages(oldest) {
  const out = [];
  let cursor;
  do {
    const j = await slack('conversations.history', { channel: SLACK_CHANNEL, oldest, limit: '200', ...(cursor ? { cursor } : {}) });
    for (const m of j.messages) {
      out.push(m);
      if (m.reply_count && m.thread_ts) {
        const rep = await slack('conversations.replies', { channel: SLACK_CHANNEL, ts: m.thread_ts, oldest, limit: '200' });
        out.push(...rep.messages.filter((x) => x.ts !== m.ts));
      }
    }
    cursor = j.response_metadata?.next_cursor;
  } while (cursor);
  return out
    .filter((m) => Number(m.ts) > Number(oldest) && !m.bot_id && (!m.subtype || m.subtype === 'thread_broadcast') && (m.text || '').trim())
    .filter((m) => !SLACK_USER_ID || m.user === SLACK_USER_ID)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

function addTasks(data, items, source) {
  let base = Date.now();
  const focusIds = new Set(data.focuses.map((f) => f.id));
  for (const t of items) {
    let focus = String(t.focus || 'other');
    if (focus.startsWith('new:')) {
      const name = focus.slice(4).trim() || 'Прочее';
      const ex = data.focuses.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (ex) focus = ex.id;
      else { focus = 'f_' + base.toString(36); data.focuses.push({ id: focus, name, color: data.focuses.length % 8, order: data.focuses.length }); focusIds.add(focus); }
    } else if (!focusIds.has(focus)) focus = 'other';
    data.tasks.push({
      id: 't_' + (base++).toString(36) + Math.random().toString(36).slice(2, 6),
      title: String(t.title).slice(0, 200), focus,
      column: ['inbox', 'today', 'doing', 'waiting', 'done'].includes(t.column) ? t.column : 'inbox',
      priority: ['high', 'med', 'low'].includes(t.priority) ? t.priority : 'med',
      tags: Array.isArray(t.tags) ? t.tags.slice(0, 5).map(String) : [], notes: t.notes ? String(t.notes) : '',
      due: t.due || null, source, order: base, createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
}

(async () => {
  let { data, sha } = await readData();
  data.meta ||= {}; data.tasks ||= []; data.focuses ||= [];
  const oldest = data.meta.slackTs || String(Math.floor(Date.now() / 1000) - 2 * 86400);
  const msgs = await fetchMessages(oldest);
  if (!msgs.length) { console.log('Новых сообщений нет.'); return; }
  console.log(`Новых сообщений: ${msgs.length}`);

  const text = msgs.map((m) => `[${new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ')}] ${m.text}`).join('\n').slice(-40000);
  const prompt = buildParsePrompt({
    text, todayISO: new Date().toISOString().slice(0, 10), sourceHint: 'Slack-канал #claude-me',
    focuses: data.focuses.map((f) => ({ id: f.id, name: f.name })),
    existingTitles: data.tasks.filter((t) => t.column !== 'done').map((t) => t.title).slice(0, 150),
  });
  const items = extractJson(await askClaude({ apiKey: ANTHROPIC_API_KEY, prompt }));
  console.log(`Задач найдено: ${items.length}`);
  const lastTs = msgs[msgs.length - 1].ts;
  const source = 'Slack · ' + new Date().toISOString().slice(0, 10);

  for (let attempt = 0; attempt < 3; attempt++) {
    addTasks(data, items, source);
    data.meta.slackTs = lastTs;
    data.meta.slackSyncedAt = Date.now();
    const r = await writeData(data, sha, `Slack: +${items.length} задач`);
    if (r.ok) { console.log('Сохранил.'); return; }
    if (r.status !== 409 && r.status !== 422) throw new Error('GitHub PUT ' + r.status + ': ' + (await r.text()));
    ({ data, sha } = await readData()); data.meta ||= {}; data.tasks ||= []; data.focuses ||= [];
  }
  throw new Error('Не смог сохранить из-за конфликтов');
})().catch((e) => { console.error(e.message); process.exit(1); });
