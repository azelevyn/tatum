require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const TATUM_API_KEY = process.env.TATUM_API_KEY;

// Start command
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `Hello ${msg.from.first_name}!\nSend /createaccount to create your virtual account.`);
});

// Command to create customer + virtual account
bot.onText(/\/createaccount/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        // Step 1: Create customer
        const customerResponse = await axios.post(
            'https://api.tatum.io/v3/ledger/customer',
            {
                firstName: msg.from.first_name,
                lastName: msg.from.last_name || "TelegramUser",
                email: `${msg.from.id}@telegram.fake`, // fake email for demo
            },
            {
                headers: {
                    'x-api-key': TATUM_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );

        const customerId = customerResponse.data.id;

        // Step 2: Create virtual account
        const accountResponse = await axios.post(
            'https://api.tatum.io/v3/ledger/account',
            {
                currency: "USD",
                customer: customerId,
                accountCode: `ACCT${msg.from.id}`,
                accountingCurrency: "USD",
                description: "Telegram virtual account"
            },
            {
                headers: {
                    'x-api-key': TATUM_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );

        const accountData = accountResponse.data;

        // Send success message
        bot.sendMessage(chatId, `✅ Virtual account created!\n\nAccount ID: ${accountData.id}\nCurrency: ${accountData.currency}\nBalance: ${accountData.balance}`);
    } catch (error) {
        console.error(error.response ? error.response.data : error.message);
        bot.sendMessage(chatId, `❌ Failed to create account. Please try again.`);
    }
});
