const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');
const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

// Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// CoinPayments Client
const client = new CoinPayments({
  key: process.env.COINPAYMENTS_PUBLIC_KEY,
  secret: process.env.COINPAYMENTS_PRIVATE_KEY
});

// Express server for IPN
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// In-memory users (replace with DB for production)
let users = {};

// Mining Plans
const plans = {
  Standard: { cost: 10, speed: 2 },
  Elite: { cost: 25, speed: 5 },
  Supreme: { cost: 50, speed: 10 },
  Legend: { cost: 250, speed: 25 }
};

// --- Helper: Main Menu ---
function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Buy Plan", callback_data: "buy_plan" }],
        [{ text: "Mine", callback_data: "mine" }],
        [{ text: "Balance", callback_data: "balance" }],
        [{ text: "Withdraw", callback_data: "withdraw" }]
      ]
    }
  };
}

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `Welcome ${msg.from.first_name}!\nUse the menu below to navigate:`, mainMenu());
});

// Handle button callbacks
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  if (!users[userId]) users[userId] = { balance: 0, plan: null, miningSpeed: 0, lastCollected: null };

  switch (data) {

    case "buy_plan":
      let text = "Select a mining plan:";
      let buttons = [];
      for (let key in plans) {
        buttons.push([{ text: `${key} (${plans[key].cost} USDT)`, callback_data: `plan_${key}` }]);
      }
      bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
      break;

    case "mine":
      const user = users[userId];
      if (!user.plan) return bot.sendMessage(chatId, "You have no active plan. Buy one first.");

      const now = new Date();
      if (user.lastCollected && now - user.lastCollected < 24 * 60 * 60 * 1000) {
        const remaining = 24 * 60 * 60 * 1000 - (now - user.lastCollected);
        return bot.sendMessage(chatId, `You already mined today. Try again in ${Math.ceil(remaining / 3600000)} hours.`);
      }

      const reward = user.miningSpeed * 10;
      user.balance += reward;
      user.lastCollected = now;
      bot.sendMessage(chatId, `You mined ${reward} coins today! Total balance: ${user.balance}`);
      break;

    case "balance":
      bot.sendMessage(chatId, `Your balance: ${users[userId].balance} coins`);
      break;

    case "withdraw":
      bot.sendMessage(chatId, "Please enter your TRC20 wallet address for withdrawal.\nFormat: `/sendwallet YOUR_TRX_ADDRESS`");
      break;
  }
});

// --- Handle Plan Purchase ---
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const userId = callbackQuery.from.id;

  if (data.startsWith("plan_")) {
    const planName = data.split("_")[1];
    const planData = plans[planName];

    try {
      const tx = await client.createTransaction({
        currency1: 'USDT',
        currency2: 'USDT',
        amount: planData.cost,
        buyer_email: `${callbackQuery.from.username || callbackQuery.from.first_name}@example.com`,
        custom: JSON.stringify({ userId, plan: planName })
      });

      bot.sendMessage(chatId, `Please pay ${planData.cost} USDT:\n${tx.status_url}\nYour plan will activate automatically once payment is confirmed.`);
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, "Error creating payment.");
    }
  }
});

// --- Handle Withdrawal Input ---
bot.onText(/\/sendwallet (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user = users[userId];

  if (!user || user.balance <= 0) return bot.sendMessage(chatId, "You have no coins to withdraw.");

  const address = match[1];
  const amount = user.balance;
  const fee = parseFloat(process.env.WITHDRAW_FEE || 0);
  const sendAmount = amount - fee;

  if (sendAmount <= 0) return bot.sendMessage(chatId, `Your balance is too low for withdrawal (minimum fee ${fee} USDT).`);

  try {
    const tx = await client.createWithdrawal({
      currency: 'USDT',
      amount: sendAmount,
      address: address,
      auto_confirm: 1
    });

    user.balance = 0;
    bot.sendMessage(chatId, `Withdrawal successful!\nAmount: ${sendAmount} USDT\nTx ID: ${tx.id}`);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, `Withdrawal failed: ${err.message}`);
  }
});

// --- COINPAYMENTS IPN ---
app.post('/ipn', (req, res) => {
  if (req.body.ipn_secret !== process.env.IPN_SECRET) return res.status(400).send('Invalid IPN');

  const status = parseInt(req.body.status);
  if (status >= 100) {
    try {
      const customData = JSON.parse(req.body.custom);
      const { userId, plan } = customData;
      const planData = plans[plan];

      if (!users[userId]) users[userId] = { balance: 0 };
      users[userId].plan = plan;
      users[userId].miningSpeed = planData.speed;
      users[userId].lastCollected = null;

      bot.sendMessage(userId, `Your plan "${plan}" is now active! Start mining using the menu.`);
    } catch (err) {
      console.error("IPN parse error:", err);
    }
  }
  res.status(200).send('OK');
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IPN server running on port ${PORT}`));
