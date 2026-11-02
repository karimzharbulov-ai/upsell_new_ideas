// Общий промпт разбора задач: подключается страницей (docs/index.html) и GitHub Action (scripts/slack-sync.js).
(function (root) {
  const MODEL = 'claude-sonnet-5-5';

  function buildParsePrompt({ text, focuses, existingTitles, todayISO, sourceHint }) {
    return `Ты ведёшь трекер задач продакт-менеджера Карима (мобильное приложение; занимается ревью и рейтингами в App Store, Google Play и Trustpilot, аналитикой, ресерчем новых продуктов). Сегодня ${todayISO}.

Разбери текст ниже на отдельные конкретные задачи. Правила:
- Заголовок: короткое действие по-русски, начинается с глагола, до 90 символов. Сохраняй термины. Сокращения: ТП = Trustpilot, АС = App Store, ТС = Trustpilot, ПРД = PRD.
- focus: id одного из существующих фокусов, либо "new:Название", если ни один не подходит (новый фокус только для явно новой темы). Существующие фокусы: ${JSON.stringify(focuses)}
- column: "today" если сказано сегодня/срочно/горит; "waiting" если ждём кого-то или чей-то ответ/доступ; "doing" если уже в процессе; "done" если сказано, что сделано; иначе "inbox".
- priority: "high" | "med" | "low".
- tags: 0–3 коротких тега из платформ и людей (iOS, Android, App Store, Trustpilot, Google Play, имя человека).
- notes: контекст, факты и инсайты из текста, относящиеся к задаче (может быть пустой строкой). Факты без действия не делай отдельными задачами, а клади в notes ближайшей задачи.
- due: "YYYY-MM-DD", если назван срок, иначе null.
- Не дублируй задачи, которые уже есть на доске: ${JSON.stringify(existingTitles)}
${sourceHint ? '- Источник текста: ' + sourceHint + '. Это переписка; бери только задачи и договорённости Карима, игнорируй служебные сообщения ботов.' : ''}

Ответь только JSON вида {"tasks":[{"title":"...","focus":"...","column":"inbox","priority":"med","tags":[],"notes":"","due":null}]}. Если задач нет, верни {"tasks":[]}.

Текст:
"""
${text}
"""`;
  }

  function extractJson(reply) {
    const s = String(reply || '').trim();
    const tryParse = (x) => { try { return JSON.parse(x); } catch { return undefined; } };
    let v = tryParse(s);
    if (v === undefined) { const m = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) v = tryParse(m[1]); }
    if (v === undefined) { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) v = tryParse(s.slice(a, b + 1)); }
    const arr = Array.isArray(v) ? v : Array.isArray(v?.tasks) ? v.tasks : [];
    return arr.filter((t) => t && typeof t.title === 'string' && t.title.trim());
  }

  async function askClaude({ apiKey, prompt, browser, fetchImpl }) {
    const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const res = await (fetchImpl || fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(body?.error?.message || ('Anthropic API ' + res.status)); err.status = res.status; throw err; }
    return (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  }

  const api = { MODEL, buildParsePrompt, extractJson, askClaude };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TaskParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
