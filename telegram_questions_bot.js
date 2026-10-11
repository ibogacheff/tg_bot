// Telegram questions with previews, optional authorship, and manual moderation.
// Requires Node.js 18+; no npm packages.
const fs = require('node:fs');
const path = require('node:path');

const token = process.env.BOT_TOKEN;
const adminId = Number(process.env.ADMIN_ID || 0);
const channelId = process.env.CHANNEL_ID || '';
const dataPath = process.env.DATA_FILE || path.join(__dirname, 'questions-data.json');

if (!token) {
  console.error('Set BOT_TOKEN in the environment before starting the bot.');
  process.exit(1);
}

function load() {
  try { return JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { offset: 0, questions: {} };
    throw error;
  }
}

const state = load();
const orderedQuestions = Object.values(state.questions).sort((a, b) =>
  (a.submittedAt || '').localeCompare(b.submittedAt || ''));
let highestNumber = Math.max(0, ...orderedQuestions.map(q => q.number || 0));
for (const question of orderedQuestions) {
  question.anonymous ??= true;
  if (!question.number && ['pending', 'approved', 'rejected'].includes(question.status)) {
    question.number = ++highestNumber;
  }
}
const published = orderedQuestions.filter(q => q.status === 'approved').sort((a, b) =>
  (a.channelMessageId || 0) - (b.channelMessageId || 0));
let highestPostNumber = Math.max(0, ...published.map(q => q.postNumber || 0));
for (const question of published) if (!question.postNumber) question.postNumber = ++highestPostNumber;
state.nextQuestionNumber = Math.max(state.nextQuestionNumber || 1, highestNumber + 1);
state.nextPostNumber = Math.max(state.nextPostNumber || 1, highestPostNumber + 1);

function save() {
  const temporary = `${dataPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, dataPath);
}

async function api(method, params = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params), signal: AbortSignal.timeout(35000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`${method}: ${result.description || response.status}`);
  return result.result;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function authorLabel(question) {
  if (question.author?.username) return `@${question.author.username}`;
  return question.author?.name || 'Участник';
}

function authorLine(question) {
  return question.anonymous
    ? '🎭 <i>Прислано анонимно</i>'
    : `👤 <b>Автор:</b> ${escapeHtml(authorLabel(question))}`;
}

function formatChannelPost(question) {
  return `💬 <b>Вопрос участника №${question.postNumber}</b>\n\n` +
    `<blockquote>${escapeHtml(question.text)}</blockquote>\n\n${authorLine(question)}`;
}

function channelButtons() {
  if (!state.botUsername) return undefined;
  return { inline_keyboard: [[{
    text: '✍️ Задать свой вопрос', url: `https://t.me/${state.botUsername}`,
  }]] };
}

function moderationButtons(id) {
  return { inline_keyboard: [[
    { text: '✅ Опубликовать', callback_data: `approve:${id}` },
    { text: '❌ Отклонить', callback_data: `reject:${id}` },
  ]] };
}

function draftButtons(question) {
  return { inline_keyboard: [
    [
      { text: question.anonymous ? '✅ Анонимно' : '🎭 Анонимно', callback_data: `anon:${question.id}` },
      { text: question.anonymous ? '👤 С моим именем' : '✅ С моим именем', callback_data: `named:${question.id}` },
    ],
    [{ text: '📨 Отправить на модерацию', callback_data: `submit:${question.id}` }],
    [{ text: 'Отменить', callback_data: `cancel:${question.id}` }],
  ] };
}

function formatDraftText(question) {
  return `📝 <b>Ваш вопрос</b>\n\n<blockquote>${escapeHtml(question.text)}</blockquote>\n\n` +
    `${authorLine(question)}\n\n` +
    (question.anonymous
      ? 'В канале ваше имя не появится. Можно выбрать публикацию с именем.'
      : 'Эта подпись будет видна всем в канале.') +
    '\n\nПроверьте вопрос и отправьте его на модерацию.';
}

function formatReviewText(question) {
  const status = question.status === 'approved' ? '✅ Опубликован'
    : question.status === 'rejected' ? '❌ Отклонён' : '📥 На модерации';
  return `${status} · <b>Вопрос №${question.number}</b>\n\n` +
    `<blockquote>${escapeHtml(question.text)}</blockquote>\n\n${authorLine(question)}`;
}

async function showToAdmin(question) {
  const message = await api('sendMessage', {
    chat_id: adminId, text: formatReviewText(question), parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: moderationButtons(question.id),
  });
  question.reviewMessageId = message.message_id;
  save();
}

async function showDraft(question) {
  const message = await api('sendMessage', {
    chat_id: question.userId, text: formatDraftText(question), parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: draftButtons(question),
  });
  question.previewMessageId = message.message_id;
  save();
}

async function editText(chatId, messageId, text, replyMarkup = { inline_keyboard: [] }) {
  try {
    await api('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }, reply_markup: replyMarkup,
    });
  } catch (error) {
    if (!/message is not modified|message to edit not found/i.test(error.message)) throw error;
  }
}

async function handleMessage(message) {
  if (message.chat?.type !== 'private' || !message.from?.id) return;
  const userId = message.from.id;
  const text = (message.text || '').trim();

  if (text === '/id' || text === '/start') {
    state.knownUsers ||= {};
    state.knownUsers[userId] = {
      id: userId, username: message.from.username || '', name: message.from.first_name || '',
    };
    save();
  }
  if (text === '/id') {
    await api('sendMessage', { chat_id: userId, text: `Ваш Telegram ID: ${userId}` });
    return;
  }
  if (text === '/start' || text === '/help') {
    await api('sendMessage', { chat_id: userId, text:
      '💬 Какой вопрос вы хотите обсудить?\n\nПришлите его одним текстовым сообщением. Я покажу предпросмотр: по умолчанию публикация анонимная, но можно выбрать свою подпись. Затем нажмите «Отправить на модерацию».\n\nАдминистратор решит, публиковать ли вопрос. Анонимность относится к публикации в канале: администратор может видеть ваш Telegram ID.\n\nДо 3000 символов.' });
    return;
  }
  if (userId === adminId && text === '/queue') {
    const pending = Object.values(state.questions).filter(q => q.status === 'pending');
    if (!pending.length) await api('sendMessage', { chat_id: adminId, text: 'Очередь пуста.' });
    else for (const question of pending) await showToAdmin(question);
    return;
  }
  if (text.startsWith('/')) {
    await api('sendMessage', { chat_id: userId, text: 'Пришлите вопрос обычным текстовым сообщением.' });
    return;
  }
  if (!adminId || !channelId) {
    await api('sendMessage', { chat_id: userId, text: 'Бот ещё настраивается. Попробуйте позже.' });
    return;
  }
  if (!text || text.length > 3000) {
    await api('sendMessage', { chat_id: userId, text: 'Пока принимаю только текст до 3000 символов. Отправьте вопрос одним сообщением.' });
    return;
  }

  const id = `${message.chat.id}_${message.message_id}`;
  if (!state.questions[id]) {
    state.questions[id] = {
      id, text, userId, status: 'draft', anonymous: true,
      author: { username: message.from.username || '', name: [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') },
      submittedAt: new Date().toISOString(),
    };
    save();
  }
  const question = state.questions[id];
  if (question.status === 'draft' && !question.previewMessageId) await showDraft(question);
}

async function answer(callback, text, alert = false) {
  try {
    await api('answerCallbackQuery', { callback_query_id: callback.id, text, show_alert: alert });
  } catch (error) {
    if (!/query is too old|query ID is invalid/i.test(error.message)) throw error;
  }
}

async function handleAuthorCallback(callback, action, question) {
  if (callback.from?.id !== question.userId) {
    await answer(callback, 'Этот вопрос принадлежит другому участнику.', true);
    return;
  }
  if (action === 'submit' && question.status === 'pending') {
    // Replayed updates must not create duplicate review cards.
    if (!question.reviewMessageId) await showToAdmin(question);
  } else if (question.status !== 'draft') {
    await answer(callback, 'Этот вопрос уже отправлен или отменён.');
    return;
  } else if (action === 'anon' || action === 'named') {
    question.anonymous = action === 'anon';
    save();
    await editText(question.userId, question.previewMessageId, formatDraftText(question), draftButtons(question));
    await answer(callback, question.anonymous ? 'Публикация будет анонимной.' : `Подпись: ${authorLabel(question)}`);
    return;
  } else if (action === 'cancel') {
    question.status = 'cancelled';
    save();
    await editText(question.userId, question.previewMessageId, 'Вопрос отменён. Можете прислать другой.');
    await answer(callback, 'Отменено.');
    return;
  } else if (action === 'submit') {
    question.number = state.nextQuestionNumber++;
    question.status = 'pending';
    save();
    await showToAdmin(question);
  }
  await editText(question.userId, question.previewMessageId,
    `📨 <b>Вопрос №${question.number} отправлен на модерацию.</b>\n\n${authorLine(question)}\n\nЯ сообщу о решении администратора.`);
  await answer(callback, 'Отправлено на модерацию.');
}

async function handleCallback(callback) {
  const match = /^(approve|reject|anon|named|submit|cancel):(-?\d+_\d+)$/.exec(callback.data || '');
  if (!match) { await answer(callback, 'Неизвестное действие.'); return; }
  const [, action, id] = match;
  const question = state.questions[id];
  if (!question) { await answer(callback, 'Этот вопрос не найден.'); return; }
  if (!['approve', 'reject'].includes(action)) {
    await handleAuthorCallback(callback, action, question);
    return;
  }
  if (callback.from?.id !== adminId) {
    await answer(callback, 'Кнопки доступны только администратору.', true);
    return;
  }
  if (question.status !== 'pending') {
    await answer(callback, 'Этот вопрос уже обработан.');
    return;
  }
  if (action === 'approve') {
    question.postNumber = state.nextPostNumber;
    const post = await api('sendMessage', {
      chat_id: channelId, text: formatChannelPost(question), parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }, reply_markup: channelButtons(),
    });
    question.status = 'approved';
    question.channelMessageId = post.message_id;
    state.nextPostNumber++;
  } else question.status = 'rejected';
  question.decidedAt = new Date().toISOString();
  save();
  await answer(callback, action === 'approve' ? 'Опубликовано.' : 'Отклонено.');
  if (callback.message?.chat?.id && callback.message.message_id) {
    await editText(callback.message.chat.id, callback.message.message_id, formatReviewText(question));
  }
  try {
    await api('sendMessage', {
      chat_id: question.userId,
      text: action === 'approve' ? `✅ Ваш вопрос опубликован под №${question.postNumber}.` : 'Ваш вопрос не был опубликован.',
    });
  } catch (error) { console.error('Could not notify submitter:', error.message); }
}

// Refresh old cards and posts during upgrades without publishing duplicates.
async function refreshExistingMessages() {
  const me = await api('getMe');
  state.botUsername = me.username;
  save();
  for (const question of Object.values(state.questions)) {
    if (question.status === 'approved' && question.channelMessageId) {
      await editText(channelId, question.channelMessageId, formatChannelPost(question), channelButtons());
    }
    if (question.reviewMessageId) {
      await editText(adminId, question.reviewMessageId, formatReviewText(question),
        question.status === 'pending' ? moderationButtons(question.id) : { inline_keyboard: [] });
    }
  }
}

async function main() {
  const me = await api('getMe');
  state.botUsername = me.username;
  save();
  console.log(`Running @${me.username}. Moderator: ${adminId || 'not set'}. Channel: ${channelId || 'not set'}.`);
  while (true) {
    try {
      const updates = await api('getUpdates', {
        offset: state.offset, timeout: 25,
        allowed_updates: ['message', 'callback_query', 'channel_post'],
      });
      for (const update of updates) {
        try {
          if (update.message) await handleMessage(update.message);
          if (update.callback_query) await handleCallback(update.callback_query);
          if (update.channel_post) {
            state.channels ||= {};
            const chat = update.channel_post.chat;
            state.channels[chat.id] = { id: chat.id, title: chat.title || '', username: chat.username || '' };
          }
          state.offset = update.update_id + 1;
          save();
        } catch (error) { console.error(`Update ${update.update_id} failed:`, error.message); break; }
      }
    } catch (error) { console.error('Polling failed:', error.message); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { handleMessage, handleCallback, main, refreshExistingMessages, formatChannelPost };
