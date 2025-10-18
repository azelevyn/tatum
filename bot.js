require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const cp = new CoinPayments({
  key: process.env.COINPAYMENTS_PUBLIC_KEY,
  secret: process.env.COINPAYMENTS_PRIVATE_KEY
});
const adminUsernames = process.env.ADMIN_USERNAMES.split(',');

// --- DATABASE ---
const db = new sqlite3.Database('./p2pbot.db');

db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER UNIQUE,
  username TEXT,
  balance_usd REAL DEFAULT 0
)`);

db.run(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER,
  type TEXT,
  crypto TEXT,
  amount REAL,
  address TEXT,
  status TEXT
)`);

// --- MENU ---
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "💰 Buy Crypto", callback_data: "buy" }],
      [{ text: "💵 Sell Crypto", callback_data: "sell" }],
      [{ text: "📊 My Wallet", callback_data: "wallet" }],
      [{ text: "👥 Referral", callback_data: "referral" }],
      [{ text: "⚙️ Admin Panel", callback_data: "admin" }]
    ]
  }
};

// --- START ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;
  db.run(`INSERT OR IGNORE INTO users (chat_id, username) VALUES (?, ?)`, [chatId, username]);
  bot.sendMessage(chatId, `Welcome to P2P Bot, ${msg.from.first_name}! Choose an option:`, mainMenu);
});

// --- CALLBACK ---
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const isAdmin = adminUsernames.includes(query.from.username);

  switch (data) {
    case "buy": return cryptoMenu(chatId, "buy");
    case "sell": return cryptoMenu(chatId, "sell");
    case "wallet": return showWallet(chatId);
    case "referral": return showReferral(chatId);
    case "admin": 
      if (isAdmin) return showAdminPanel(chatId);
      return bot.sendMessage(chatId, "❌ You are not an admin.");
    case "back": return bot.sendMessage(chatId, "Main menu:", mainMenu);
  }

  if (data.startsWith("buy_") || data.startsWith("sell_")) {
    const [action, crypto] = data.split("_");
    return handleOrder(chatId, action, crypto.toUpperCase());
  }

  if (!isAdmin) return;
  if (data === "admin_balances") return showTotalBalances(chatId);
  if (data === "admin_orders") return showAllOrders(chatId);

  bot.answerCallbackQuery(query.id);
});

// --- MENU FUNCTIONS ---
function cryptoMenu(chatId, type) {
  const menu = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "USDT", callback_data: `${type}_usdt` }],
        [{ text: "BTC", callback_data: `${type}_btc` }],
        [{ text: "ETH", callback_data: `${type}_eth` }],
        [{ text: "⬅️ Back", callback_data: "back" }]
      ]
    }
  };
  bot.sendMessage(chatId, `Select crypto to ${type}:`, menu);
}

function showWallet(chatId) {
  db.get(`SELECT balance_usd FROM users WHERE chat_id=?`, [chatId], (err, row) => {
    const balance = row ? row.balance_usd : 0;
    bot.sendMessage(chatId, `💼 Your balance: ${balance} USD`);
  });
}

function showReferral(chatId) {
  const link = `https://t.me/YourBot?start=${chatId}`;
  bot.sendMessage(chatId, `🔗 Your referral link: ${link}`);
}

// --- ORDER HANDLER ---
function handleOrder(chatId, action, crypto) {
  bot.sendMessage(chatId, `Enter amount in USD to ${action} ${crypto}:`);

  const listener = async (msg) => {
    if (msg.chat.id !== chatId) return;
    const amount = parseFloat(msg.text);
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "Invalid amount. Try again.");
    bot.removeListener("message", listener);

    // CREATE COINPAYMENTS TRANSACTION
    try {
      const tx = await cp.createTransaction({
        currency1: "USD",
        currency2: crypto,
        amount,
        buyer_email: `${chatId}@p2pbot.com`, // dummy email
        item_name: `${action.toUpperCase()} ${crypto} via P2P Bot`
      });

      db.run(`INSERT INTO orders (chat_id, type, crypto, amount, address, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [chatId, action, crypto, amount, tx.address || tx.checkout_url, "pending"]);

      const qr = await QRCode.toDataURL(tx.checkout_url || tx.address);

      bot.sendMessage(chatId, `Send your payment to this address:\n\n${tx.address || tx.checkout_url}`);
      bot.sendPhoto(chatId, qr, { caption: "Scan QR to pay" });

    } catch (err) {
      console.error(err.message);
      bot.sendMessage(chatId, "Error creating transaction. Try again later.");
    }
  };

  bot.on("message", listener);
}

// --- ADMIN PANEL ---
function showAdminPanel(chatId) {
  const menu = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 Total Balances", callback_data: "admin_balances" }],
        [{ text: "📦 Orders", callback_data: "admin_orders" }],
        [{ text: "⬅️ Back", callback_data: "back" }]
      ]
    }
  };
  bot.sendMessage(chatId, "Admin Panel:", menu);
}

function showTotalBalances(chatId) {
  db.get(`SELECT SUM(balance_usd) AS total FROM users`, [], (err, row) => {
    const total = row ? row.total : 0;
    bot.sendMessage(chatId, `💰 Total balances: ${total} USD`);
  });
}

function showAllOrders(chatId) {
  db.all(`SELECT * FROM orders`, [], (err, rows) => {
    if (!rows.length) return bot.sendMessage(chatId, "No orders yet.");
    let text = rows.map(o => `User: ${o.chat_id}, ${o.type} ${o.crypto}, $${o.amount}, Status: ${o.status}`).join("\n");
    bot.sendMessage(chatId, text);
  });
}
