const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const configPath = path.join(root, 'bot-config.json');
const lockPath = path.join(root, 'bot-process.json');
if (!fs.existsSync(configPath)) {
  console.error('Сначала запустите setup.cmd.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.token || !config.adminId || !config.channelId) {
  console.error('В bot-config.json не хватает токена, ID модератора или канала.');
  process.exit(1);
}

try {
  const old = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  try {
    process.kill(old.pid, 0);
    console.error('Бот уже запущен. Вторую копию запускать нельзя.');
    process.exit(1);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  fs.unlinkSync(lockPath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
process.on('exit', () => {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {}
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

process.env.BOT_TOKEN = config.token;
process.env.ADMIN_ID = String(config.adminId);
process.env.CHANNEL_ID = String(config.channelId);
process.env.DATA_FILE = path.join(root, 'questions-data.json');

require('./telegram_questions_bot.js').main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
