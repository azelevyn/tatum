// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const TATUM_KEY = process.env.TATUM_API_KEY;
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES||'').split(',').map(s=>s.trim()).filter(Boolean);

if (!BOT_TOKEN || !TATUM_KEY) {
  console.error("Set TELEGRAM_TOKEN and TATUM_API_KEY in .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const TATUM_BASE = 'https://api.tatum.io';

// --- simple in-memory DB (replace with real DB in production) ---
const db = {
  users: {}, // telegramId -> { username, accounts: { currency: accountId } }
  accounts: {}, // accountId -> { telegramId, currency, depositAddresses: [] }
};

// helper: set headers
const tatum = axios.create({
  baseURL: TATUM_BASE,
  headers: {
    'x-api-key': TATUM_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  timeout: 20000
});

// ---------- Helper functions for Tatum ----------
async function createVirtualAccountForUser(telegramId, currency) {
  // currency example: "ETH", "TRX", or token like "USDT-TRON" - sesuaikan sesuai docs
  const body = {
    currency,
    // optional: set customer/externalId to link VA to your user
    customer: { externalId: `tg_${telegramId}` },
    // optional: availableBalance, description, etc.
  };
  const resp = await tatum.post('/v3/ledger/account', body);
  return resp.data; // contains id, currency, accountBalance, ...
}

async function generateDepositAddressForAccount(accountId) {
  // Endpoint: POST /v3/offchain/account/{Virtual_Account_ID}/address
  const resp = await tatum.post(`/v3/offchain/account/${accountId}/address`);
  return resp.data; // contains xpub/derivationKey/address depending on chain
}

async function getAccountDetails(accountId) {
  const resp = await tatum.get(`/v3/ledger/account/${accountId}`);
  return resp.data;
}

async function initiateWithdrawFromVirtualAccount({accountId, amount, address, currency}) {
  // Tatum has different flows; try unified "offchain/withdrawal" or blockchain ops.
  // We'll call the offchain withdrawal endpoint which creates a withdrawal request.
  const body = {
    senderAccountId: accountId,
    amount: amount.toString(),
    address,
    currency
  };
  // endpoint for creating withdrawal request (may vary by currency/chain)
  const resp = await tatum.post('/v3/offchain/withdrawal', body);
  return resp.data;
}

// ---------- Bot command handlers ----------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || msg.from.username || 'User';
  bot.sendMessage(chatId, `Hi ${name}!\nSaya bot demo Tatum exchange.\nPilih perintah:\n/balance - cek saldo\n/deposit - buat virtual account & alamat deposit\n/withdraw - minta withdraw\n/admin - (hidden, username-based)`);
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = db.users[chatId];
    if (!user || !user.accounts || Object.keys(user.accounts).length === 0) {
      return bot.sendMessage(chatId, `Belum ada virtual account. Gunakan /deposit untuk membuat VA.`);
    }
    let text = `Saldo kamu:\n`;
    for (const [currency, accId] of Object.entries(user.accounts)) {
      const acc = await getAccountDetails(accId);
      text += `\n${currency}: available=${acc.availableBalance || acc.accountBalance || 0} (accountId: ${accId})`;
    }
    bot.sendMessage(chatId, text);
  } catch (e) {
    console.error(e.response?.data || e.message);
    bot.sendMessage(chatId, `Error saat cek saldo: ${e.response?.data?.message || e.message}`);
  }
});

bot.onText(/\/deposit/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || `${msg.from.first_name||''}`;
  // For demo: default currency = USDT-TRON (ubah sesuai kebutuhan)
  const currency = 'USDT-TRON'; // <-- sesuaikan/mapping sesuai Tatum docs
  try {
    // if user already has VA for currency, reuse
    db.users[chatId] = db.users[chatId] || { username, accounts: {} };
    if (db.users[chatId].accounts[currency]) {
      const accId = db.users[chatId].accounts[currency];
      // show existing deposit addresses
      const acc = db.accounts[accId];
      return bot.sendMessage(chatId, `Kamu sudah punya VA untuk ${currency} (accountId: ${accId}).\nAddresses:\n${(acc.depositAddresses||[]).join('\n') || '(belum ada alamat, hub admin)'}`);
    }

    // 1) create virtual account
    const created = await createVirtualAccountForUser(chatId, currency);
    const accountId = created.id || created.accountId || created.ledgerAccountId || created.account; // beberapa response shape
    if (!accountId) throw new Error('Tidak mendapat accountId dari Tatum (cek API key & param)');

    // save mapping
    db.users[chatId].accounts[currency] = accountId;
    db.accounts[accountId] = { telegramId: chatId, currency, depositAddresses: [] };

    // 2) generate deposit address
    const addrResp = await generateDepositAddressForAccount(accountId);
    // response shape bisa berbeda per chain; try a few properties:
    const address = addrResp.address || addrResp.xpub || addrResp.result || JSON.stringify(addrResp);
    db.accounts[accountId].depositAddresses.push(address);

    bot.sendMessage(chatId, `✅ VA dibuat untuk ${currency}\nAccount ID: ${accountId}\nDeposit address:\n\`${address}\`\n\nSilakan deposit ke address tersebut.`, { parse_mode:'Markdown' });
  } catch (e) {
    console.error('deposit error', e.response?.data || e.message);
    bot.sendMessage(chatId, `Error saat membuat VA / alamat deposit: ${e.response?.data?.message || e.message}`);
  }
});

bot.onText(/\/withdraw (.+)/, async (msg, match) => {
  // command: /withdraw <amount>;<address>;<currency?>
  // e.g. /withdraw 10;TADDRESS;USDT-TRON
  const chatId = msg.chat.id;
  const payload = match[1].trim();
  const parts = payload.split(';').map(s=>s.trim());
  if (parts.length < 2) {
    return bot.sendMessage(chatId, `Format: /withdraw <amount>;<to_address>;<currency (opsional)>\nContoh: /withdraw 10;TXYZ...;USDT-TRON`);
  }
  const [amountStr, toAddress, currencyProvided] = parts;
  const amount = parseFloat(amountStr);
  const currency = currencyProvided || 'USDT-TRON';

  try {
    const user = db.users[chatId];
    if (!user || !user.accounts || !user.accounts[currency]) {
      return bot.sendMessage(chatId, `Kamu belum punya VA untuk ${currency}. Buat dulu /deposit`);
    }
    const accountId = user.accounts[currency];

    // Initiate withdrawal through Tatum
    const wd = await initiateWithdrawFromVirtualAccount({accountId, amount, address: toAddress, currency});
    bot.sendMessage(chatId, `Withdrawal initiated.\n${JSON.stringify(wd)}`);
  } catch (e) {
    console.error('withdraw error', e.response?.data || e.message);
    bot.sendMessage(chatId, `Error saat withdraw: ${e.response?.data?.message || e.message}`);
  }
});

// Admin hidden command: only accept if username in ADMIN_USERNAMES
bot.onText(/\/admin( .+)?/, (msg, match) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || '';
  if (!ADMIN_USERNAMES.includes(username)) {
    return bot.sendMessage(chatId, `Unknown command.`);
  }
  const arg = (match[1]||'').trim();
  if (!arg) {
    return bot.sendMessage(chatId, `Admin menu:\n/listusers\n/getaccount <accountId>\n/credits`);
  }
  const parts = arg.split(' ');
  const cmd = parts[0];
  if (cmd === 'listusers') {
    const out = Object.entries(db.users).map(([tgId,u])=>`${tgId} -> ${u.username} -> ${Object.keys(u.accounts).join(',')}`).join('\n') || '(kosong)';
    return bot.sendMessage(chatId, `Users:\n${out}`);
  } else if (cmd === 'getaccount' && parts[1]) {
    const accId = parts[1];
    const acc = db.accounts[accId];
    return bot.sendMessage(chatId, `Account ${accId}: ${JSON.stringify(acc||'not found')}`);
  } else {
    return bot.sendMessage(chatId, `Unknown admin command.`);
  }
});

// fallback: plain text messages
bot.on('message', (msg) => {
  // ignore commands handled above
  if (msg.text && msg.text.startsWith('/')) return;
  // quick help
  bot.sendMessage(msg.chat.id, `Perintah: /deposit /balance /withdraw <a>;<addr>;<currency?>\nContoh: /withdraw 5;TXYZ...;USDT-TRON`);
});

console.log('Bot running...');
