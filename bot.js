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
  Standard: { cost: 0.01, speed: 2 }, // cost in ETH (or BTC equivalent)
  Elite: { cost: 0.025, speed: 5 },
  Supreme: { cost: 0.05, speed: 10 },
  Legend: { cost: 0.25, speed: 25 }
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

  // --- Main Menu ---
  switch (data) {
    case "buy_plan":
      let buttons = [];
      for (let key in plans) {
        buttons.push([
          { text: `${key} (${plans[key].cost} ETH)`, callback_data: `plan_${key}_ETH` },
          { text: `${key} (${(plans[key].cost / 20).toFixed(5)} BTC)`, callback_data: `plan_${key}_BTC` } // example conversion
        ]);
      }
      bot.sendMessage(chatId, "Select a mining plan and payment method:", {
        reply_markup: { inline_keyboard: buttons }
      });
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
      bot.sendMessage(chatId, "Please enter your wallet address for withdrawal.\nFormat: `/sendwallet YOUR_ADDRESS CURRENCY`\nExample: `/sendwallet 0xABCDEF ETH`");
      break;
  }

  // --- Handle Plan Purchase ---
  if (data.startsWith("plan_")) {
    const parts = data.split("_");
    const planName = parts[1];
    const currency = parts[2] || "ETH";
    const planData = plans[planName];

    try {
      const tx = await client.createTransaction({
        currency1: currency,
        currency2: currency,
        amount: planData.cost,
        buyer_email: `${callbackQuery.from.username || callbackQuery.from.first_name}@example.com`,
        custom: JSON.stringify({ userId, plan: planName, currency }),
        ipn_url: 'https://YOUR_DOMAIN/ipn'
      });

      bot.sendMessage(chatId,
        `✅ Payment created!\n\nPay **${planData.cost} ${currency}** using the link below:\n${tx.status_url}\n\nYour plan will activate automatically after payment confirmation.`
      );

    } catch (err) {
      console.error("CoinPayments createTransaction error:", err);
      bot.sendMessage(chatId, `❌ Error creating payment: ${err.message}`);
    }
  }
});

// --- Handle Withdrawal Input ---
bot.onText(/\/sendwallet (.+) (ETH|BTC)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user = users[userId];

  if (!user || user.balance <= 0) return bot.sendMessage(chatId, "You have no coins to withdraw.");

  const address = match[1];
  const currency = match[2];
  const amount = user.balance;
  const fee = parseFloat(process.env.WITHDRAW_FEE || 0);
  const sendAmount = amount - fee;

  if (sendAmount <= 0) return bot.sendMessage(chatId, `Your balance is too low for withdrawal (minimum fee ${fee} ${currency}).`);

  try {
    const tx = await client.createWithdrawal({
      currency: currency,
      amount: sendAmount,
      address: address,
      auto_confirm: 1
    });

    user.balance = 0;
    bot.sendMessage(chatId, `Withdrawal successful!\nAmount: ${sendAmount} ${currency}\nTx ID: ${tx.id}`);
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
      const { userId, plan, currency } = customData;
      const planData = plans[plan];

      if (!users[userId]) users[userId] = { balance: 0 };
      users[userId].plan = plan;
      users[userId].miningSpeed = planData.speed;
      users[userId].lastCollected = null;

      bot.sendMessage(userId, `Your plan "${plan}" (${currency}) is now active! Start mining using the menu.`);
    } catch (err) {
      console.error("IPN parse error:", err);
    }
  }
  res.status(200).send('OK');
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IPN server running on port ${PORT}`));
