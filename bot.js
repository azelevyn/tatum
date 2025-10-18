require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Users database simulation
let users = {}; // { userId: { balance: 0, orders: [] } }

// Main menu buttons
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "💰 Buy Crypto", callback_data: "buy" }],
      [{ text: "💵 Sell Crypto", callback_data: "sell" }],
      [{ text: "📊 My Wallet", callback_data: "wallet" }],
      [{ text: "👥 Referral", callback_data: "referral" }]
    ]
  }
};

// Start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!users[chatId]) users[chatId] = { balance: 0, orders: [] };
  bot.sendMessage(chatId, `Welcome to P2P Bot, ${msg.from.first_name}! Choose an option:`, mainMenu);
});

// Handle button clicks
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  switch (data) {
    case "buy":
      bot.sendMessage(chatId, "Select a crypto to buy:\n1. USDT\n2. BTC\n3. ETH");
      break;

    case "sell":
      bot.sendMessage(chatId, "Select a crypto to sell:\n1. USDT\n2. BTC\n3. ETH");
      break;

    case "wallet":
      const balance = users[chatId].balance;
      bot.sendMessage(chatId, `💼 Your balance: ${balance} USD`);
      break;

    case "referral":
      const referralLink = `https://t.me/YourBot?start=${chatId}`;
      bot.sendMessage(chatId, `🔗 Your referral link: ${referralLink}`);
      break;

    default:
      bot.sendMessage(chatId, "Unknown option.");
  }

  // Remove the "loading" state
  bot.answerCallbackQuery(query.id);
});
