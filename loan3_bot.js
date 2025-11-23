const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const schedule = require('node-schedule');
const xlsx = require('xlsx');

// Replace with your bot token
const token = '7697426305:AAHDtX2gAAzPpFjZVuUEWe9Csg7kWRFp2VY';
const bot = new TelegramBot(token, {polling: true});


// Define the bot owner's Telegram user ID
const ownerId = 1101168984;  // Replace with your actual Telegram user ID

// SQLite Database Setup
let db = new sqlite3.Database('./loans.db');

// Create Tables if they don't exist
// Adding a new column 'decline_reason' to the 'loans' table if it doesn't exist already
db.run(`ALTER TABLE loans ADD COLUMN decline_reason TEXT`, (err) => {
    if (err) {
        // This error usually means the column already exists
        if (err.message.includes("duplicate column name")) {
            console.log("The column 'decline_reason' already exists.");
        } else {
            console.error("Error adding 'decline_reason' column:", err.message);
        }
    } else {
        console.log("Column 'decline_reason' added successfully.");
    }
});
db.run(`ALTER TABLE loans ADD COLUMN remaining_amount REAL`, (err) => {
    if (err) {
        // This error usually means the column already exists
        if (err.message.includes("duplicate column name")) {
            console.log("The column 'remaining_amount' already exists.");
        } else {
            console.error("Error adding 'remaining_amount' column:", err.message);
        }
    } else {
        console.log("Column 'remaining_amount' added successfully.");
    }
});
db.run(`CREATE TABLE IF NOT EXISTS loans (
    loan_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    duration INTEGER,
    interest REAL,
    financial_status TEXT, 
    status TEXT DEFAULT 'pending',
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decline_reason TEXT,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
)`);


// Create users table
db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    balance REAL DEFAULT 0
  )`);
  
  // Create loans table with the new financial_status column
  
  // Add the new financial_status column to the existing loans table


db.run(`CREATE TABLE IF NOT EXISTS balance_requests (request_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount REAL, status TEXT DEFAULT 'pending', FOREIGN KEY(user_id) REFERENCES users(user_id))`);

// /start command
bot.onText(/\/start/, (msg) => {
    const userId = msg.from.id;
    db.run(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`, [userId]);

    const welcomeMessage = `Приветствую в LoanBot! 
    Вот основные команды которые Вы можете использовать:

1. /balancecheck - Проверить Ваш баланс.
2. /loanget - Запросить кредит.
3. /changebalance <кол-во> - Изменить свой баланс. Админ обсудит с Вами цель изменения баланса и в зависимости от разговора может измениться баланс.

Используйте /help для просмотра всех команд!
    `;
    bot.sendMessage(userId, welcomeMessage);
    updateExcelFile(userId);
});

// /balancecheck command
bot.onText(/\/balancecheck/, (msg) => {
    const userId = msg.from.id;
   
    db.get(`SELECT balance FROM users WHERE user_id = ?`, [userId], (err, row) => {
        if (err) {
            return bot.sendMessage(userId, "Error fetching balance.");
        }
        if (!row) {
            return bot.sendMessage(userId, "User not found in the database.");
        }
        bot.sendMessage(userId, `Ваш баланс: ${row.balance || 0}`);
        updateExcelFile(userId);
    });
    
});
// /chatahuman <reason> - User requests a chat with admin
bot.onText(/\/chatahuman (.+)/, (msg, match) => {
    const userId = msg.from.id;
    const reason = match[1];
    const requestTime = new Date().toLocaleString();
    updateExcelFile(userId);
    // Insert the chat request into the database
    db.run(`INSERT INTO chat_requests (user_id, reason, request_time) VALUES (?, ?, ?)`, [userId, reason, requestTime], function (err) {
        if (err) {
            return bot.sendMessage(userId, "Error submitting chat request.");
        }

        const requestId = this.lastID;  // Get the chat request ID
        bot.sendMessage(userId, `Ваш запрос на чат был сделан. ID запроса: ${requestId}`);

        // Notify admin (owner)
        bot.sendMessage(ownerId, `Новый запрос на чат от ${userId}:\n ID запроса: ${requestId}\nПричина: ${reason}\nВремя запроса: ${requestTime}`);
    });
});

// /checkchatrequests - Admin checks all pending chat requests
bot.onText(/\/checkchatrequests/, (msg) => {
    const userId = msg.from.id;
    updateExcelFile(userId);
    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой функции.");
    }

    // Query pending chat requests
    db.all(`SELECT * FROM chat_requests`, [], (err, rows) => {
        if (err) {
            return bot.sendMessage(userId, "Error fetching chat requests.");
        }

        if (rows.length === 0) {
            return bot.sendMessage(userId, "Нет ожидающих запросов.");
        }

        let chatRequests = 'Ожидающие запросы:\n';
        rows.forEach(row => {
            chatRequests += ` ID пользователя: ${row.user_id}, ID запроса: ${row.request_id}, Причина: ${row.reason}, Время запроса: ${row.request_time}\n`;
        });

        bot.sendMessage(userId, chatRequests);
    });
});

// /acceptchat <request_id> - Admin accepts a chat request
bot.onText(/\/acceptchat (\d+)/, (msg, match) => {
    const requestId = parseInt(match[1]);
    const userId = msg.from.id;
    updateExcelFile(userId);
    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой функции");
    }

    // Get the request details and initiate the chat
    db.get(`SELECT user_id, reason FROM chat_requests WHERE request_id = ?`, [requestId], (err, row) => {
        if (err || !row) {
            return bot.sendMessage(userId, "Запрос не найден");
        }

        chatSessions[userId] = row.user_id;  // Store chat session

        // Inform the admin and the user about the chat session
        bot.sendMessage(userId, `Вы теперь общаетесь с ${row.user_id}. Используйте /humanchatend чтобы завершить разговор.`);
        bot.sendMessage(row.user_id, `Админ принял ваш запрос и сейчас общается с Вами.`);

        // Delete the pending request from the database after the chat starts
        db.run(`DELETE FROM chat_requests WHERE request_id = ?`, [requestId], (err) => {
            if (err) {
                return bot.sendMessage(userId, "Error deleting the pending request.");
            }
        });
    });
});

// /humanchatend - Admin ends the chat session
bot.onText(/\/humanchatend/, (msg) => {
    const userId = msg.from.id;
    updateExcelFile(userId);
    if (chatSessions[ownerId]) {
        const targetUserId = chatSessions[ownerId];
        bot.sendMessage(userId, `Чат с ${targetUserId} был завершен.`);
        bot.sendMessage(targetUserId, `Админ завершил чат`);
        delete chatSessions[ownerId];  // End chat session

        // Clean up the request data after the chat ends
        db.run(`DELETE FROM chat_requests WHERE user_id = ?`, [targetUserId], (err) => {
            if (err) {
                return bot.sendMessage(userId, "Error cleaning up the chat request.");
            }
        });
    }
});

// /changebalance command - Request balance change
bot.onText(/\/changebalance (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    const newBalance = parseFloat(match[1]);
    updateExcelFile(userId);
    // Insert request into balance_requests table
    db.run(`INSERT INTO balance_requests (user_id, amount) VALUES (?, ?)`, [userId, newBalance], (err) => {
        if (err) {
            return bot.sendMessage(userId, "Error creating balance change request.");
        }
        bot.sendMessage(userId, `Ваш запрос на изменение баланса был записан. Админ свяжется с Вами в скором времени.`);
        bot.sendMessage(ownerId, `Новый запрос на изменение баланса от ${userId}: Запрашиваемая сумма: ${newBalance}. Используйте /chatapprove <id> чтобы связаться с пользователем.`);
    });
});


let chatSessions = {};


bot.onText(/\/chatapprove (\d+)/, (msg, match) => {
    const requestId = parseInt(match[1]);
    const userId = msg.from.id;
    updateExcelFile(userId);
    
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой команде");
    }


    db.get(`SELECT user_id, amount FROM balance_requests WHERE request_id = ? AND status = 'pending'`, [requestId], (err, row) => {
        if (err || !row) {
            return bot.sendMessage(userId, "Request not found or already processed.");
        }

        chatSessions[userId] = row.user_id;  // Store chat session

        // Inform the admin and the user about the chat session
        bot.sendMessage(userId, `Вы начали чат с ${row.user_id}. Используйте /endchat чтобы завершить разговор.`);
        bot.sendMessage(row.user_id, `Админ начал с Вами разговор по поводу изменения баланса.`);

        // Delete the pending request after the chat starts
        db.run(`DELETE FROM balance_requests WHERE request_id = ?`, [requestId], (err) => {
            if (err) {
                return bot.sendMessage(userId, "Error deleting the pending request.");
            }
        });
    });
});

// Chat between admin and user
bot.on('message', (msg) => {
    const senderId = msg.from.id;

    // If the owner is in a chat session
    if (chatSessions[ownerId]) {
        const targetUserId = chatSessions[ownerId];

        // Forward messages between owner and user
        if (senderId === ownerId) {
            bot.sendMessage(targetUserId, `Admin: ${msg.text}`);
        } else if (senderId === targetUserId) {
            bot.sendMessage(ownerId, `User ${senderId}: ${msg.text}`);
        }
    }
});

// /endchat - End the chat session
bot.onText(/\/endchat/, (msg) => {
    const userId = msg.from.id;
    updateExcelFile(userId);
    if (chatSessions[ownerId]) {
        const targetUserId = chatSessions[ownerId];
        bot.sendMessage(userId, `Разговор с ${targetUserId} был завершен.`);
        bot.sendMessage(targetUserId, `Админ завершил чат`);
        delete chatSessions[ownerId];  // End chat session
    }
});

// /balanceapprovedchange <user_id> <amount> - Approve balance change after chat
bot.onText(/\/balanceapprovedchange (\d+) (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    const newBalance = parseFloat(match[2]);
    updateExcelFile(userId);
    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой команде.");
    }

    db.run(`UPDATE users SET balance = ? WHERE user_id = ?`, [newBalance, targetUserId], (err) => {
        if (err) {
            return bot.sendMessage(userId, "Error updating balance.");
        }

        // Mark balance request as approved
        db.run(`UPDATE balance_requests SET status = 'approved' WHERE user_id = ? AND status = 'pending'`, [targetUserId], (err) => {
            if (err) {
                return bot.sendMessage(userId, "Error updating balance request status.");
            }
            bot.sendMessage(userId, `Баланс пользователя ${targetUserId} был обновлен на ${newBalance}.`);
            bot.sendMessage(targetUserId, `Ваш запрос на изменения баланса был одобрен и изменен на ${newBalance}.`);
        });
    });
});

const loanRequestFlow = {};  // Keep track of loan request flow

bot.onText(/\/loanget/, (msg) => {
    const userId = msg.from.id;
    loanRequestFlow[userId] = { stage: 'amount' };
    bot.sendMessage(userId, "Введите сумму кредита:");
});

bot.on('message', (msg) => {
    const userId = msg.from.id;

    if (loanRequestFlow[userId]) {
        const userStage = loanRequestFlow[userId].stage;

        if (userStage === 'amount') {
            loanRequestFlow[userId].amount = parseFloat(msg.text);
            loanRequestFlow[userId].stage = 'duration';

            // Show duration options as inline buttons
            bot.sendMessage(userId, "Выберите срок кредита. Если ничего из предложенного не подходит, напишите 'custom'", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "1 месяц", callback_data: "duration_1" },
                            { text: "3 месяца", callback_data: "duration_3" }
                        ],
                        [
                            { text: "6 месяца", callback_data: "duration_6" },
                            { text: "12 месяца", callback_data: "duration_12" }
                        ],
                        [
                            { text: "Вернуться", callback_data: "go_back" }
                        ]
                    ]
                }
            });

        } else if (userStage === 'duration') {
            if (msg.text.toLowerCase() === 'custom') {
                loanRequestFlow[userId].stage = 'custom_duration';
                bot.sendMessage(userId, "Введите собственный срок кредита в месяцах:", {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "Вернуться", callback_data: "go_back" }
                            ]
                        ]
                    }
                });
            } else {
                const durationData = msg.data;

                if (durationData.startsWith("go_back")) {
                    delete loanRequestFlow[userId];  // Reset the flow for the user
                    return bot.sendMessage(userId, "Процесс кредита предотвращен.");
                }

                if (durationData.startsWith("duration_")) {
                    const durationMonths = parseInt(durationData.split("_")[1]);
                    loanRequestFlow[userId].duration = durationMonths;
                    loanRequestFlow[userId].stage = 'interest';

                    bot.sendMessage(userId, "Введите процентную ставку:");
                }
            }

        } else if (userStage === 'custom_duration') {
            const customDuration = parseInt(msg.text);
            if (!isNaN(customDuration) && customDuration > 0) {
                loanRequestFlow[userId].duration = customDuration;
                loanRequestFlow[userId].stage = 'interest';

                bot.sendMessage(userId, "Введите желаемую процентную ставку:");
            } else {
                bot.sendMessage(userId, "Пожалуйста введите правильное значение в месяцах.");
            }

        } else if (userStage === 'interest') {
            if (msg.text === "Вернуться") {
                loanRequestFlow[userId].stage = 'duration';
                return bot.sendMessage(userId, "Выберите срок кредита. Если ничего из предложенного не подходит, напишите 'custom':", {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "1 месяц", callback_data: "duration_1" },
                                { text: "3 месяца", callback_data: "duration_3" }
                            ],
                            [
                                { text: "6 месяца", callback_data: "duration_6" },
                                { text: "12 месяца", callback_data: "duration_12" }
                            ],
                            [
                                { text: "Вернуться", callback_data: "go_back" }
                            ]
                        ]
                    }
                });
            }

            loanRequestFlow[userId].interest = parseFloat(msg.text);
            loanRequestFlow[userId].stage = 'financial_status'; // Move to financial status stage

            bot.sendMessage(userId, "Введите ваш финансовый статус, работу и зарплату:");
        } else if (userStage === 'financial_status') {
            loanRequestFlow[userId].financial_status = msg.text;
            const { amount, duration, interest, financial_status } = loanRequestFlow[userId];
            const requestedAt = new Date().toLocaleString();  // Get current date and time

            // Insert loan request into the database
            db.run(`INSERT INTO loans (user_id, amount, duration, interest, financial_status, status, requested_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`, 
            [userId, amount, duration, interest, financial_status, requestedAt], function (err) {
                if (err) {
                    return bot.sendMessage(userId, "Ошибка запроса кредита.");
                }

                const loanId = this.lastID;  // Get the loan ID of the inserted row

                // Send confirmation to the user
                bot.sendMessage(userId, `Запрос на кредит отправлен ${userId}!\n ID запроса на кредит: ${loanId}\nКоличество: ${amount}\nСрок: ${duration} месяцев\nПроцентная ставка: ${interest}%\nФинансовый статус: ${financial_status}\nЗапрошено в: ${requestedAt}`);

                // Notify admin (owner)
                bot.sendMessage(ownerId, `Запрос на кредит отправлен ${userId}!\n ID запроса на кредит: ${loanId}\nКоличество: ${amount}\nСрок: ${duration} месяцев\nПроцентная ставка: ${interest}%\nФинансовый статус: ${financial_status}\nЗапрошено в: ${requestedAt}`);
            });
            updateExcelFile(userId);

            delete loanRequestFlow[userId];  // Reset the flow for the user
            updateExcelFile(userId);
        }
    }
    updateExcelFile(userId);
});

// Handle callback queries for inline buttons
bot.on('callback_query', (query) => {
    const userId = query.from.id;
    const data = query.data;
    updateExcelFile(userId);
    if (loanRequestFlow[userId]) {
        if (data.startsWith("duration_")) {
            const durationMonths = parseInt(data.split("_")[1]);
            loanRequestFlow[userId].duration = durationMonths;
            loanRequestFlow[userId].stage = 'interest';
            bot.sendMessage(userId, "Введите процентную ставку:", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "Вернуться", callback_data: "go_back" }
                        ]
                    ]
                }
            });
        } else if (data === "go_back") {
            delete loanRequestFlow[userId];  // Reset the flow for the user
            bot.sendMessage(userId, "Процесс кредита предотвращен");
        }
        updateExcelFile(userId);
    }
    updateExcelFile(userId);
});


// /approve command (Owner only)
bot.onText(/\/approve (\d+)/, (msg, match) => {
    const loanId = parseInt(match[1]);
    const userId = msg.from.id;
    updateExcelFile(userId);
    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой команде");
    }

    db.get(`SELECT user_id, amount FROM loans WHERE loan_id = ?`, [loanId], (err, row) => {
        if (err) {
            return bot.sendMessage(userId, "Error fetching loan details.");
        }

        if (!row) {
            return bot.sendMessage(userId, "Запрос на кредит не найден.");
        }

        db.run(`UPDATE loans SET status = 'approved' WHERE loan_id = ?`, [loanId], function(err) {
            updateExcelFile(userId);
            if (err) {
                return bot.sendMessage(userId, "Error approving loan.");
                
            }
            updateExcelFile(userId);
            // Update user's balance
            db.run(`UPDATE users SET balance = balance + ? WHERE user_id = ?`, [row.amount, row.user_id], function(err) {
                if (err) {
                    return bot.sendMessage(userId, "Error updating user balance.");
                }

                bot.sendMessage(userId, `Запрос на кредит одобрен и баланс изменен ${row.user_id}.`);
                bot.sendMessage(row.user_id, `Ваш кредит был одобрен! ${row.amount} было начислено на Ваш баланс.Для проверки используйте /balancecheck`);
                updateExcelFile(userId);
            });
            updateExcelFile(userId);
        });
    });
    updateExcelFile(userId);
});

// /decline command (Owner only)
// /decline <id> <reason> - Admin declines a loan request with a reason
// /decline <loan_id> <reason> - Decline a loan request with a reason (Owner only)
bot.onText(/\/decline (\d+) (.+)/, (msg, match) => {
    const loanId = parseInt(match[1]);
    const reason = match[2].trim();
    const userId = msg.from.id;

    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой команде.");
    }

    // Update the loan status to 'declined' and add the decline reason
    db.run(`UPDATE loans SET status = 'declined', decline_reason = ? WHERE loan_id = ?`, [reason, loanId], function(err) {
        if (err) {
            return bot.sendMessage(userId, "Ошибка.");
        }

        if (this.changes === 0) {
            return bot.sendMessage(userId, "Не найдено запроса на кредит с таким ID.");
        }

        // Notify the user about the loan decline
        db.get(`SELECT user_id FROM loans WHERE loan_id = ?`, [loanId], (err, row) => {
            if (err || !row) {
                return bot.sendMessage(userId, "Error fetching loan details.");
            }

            bot.sendMessage(userId, `Кредит ${loanId} был отклонен. Причина: ${reason}`);
            bot.sendMessage(row.user_id, `Ваш запрос на кредит с ID ${loanId} был отклонен. Причина: ${reason}`);
        });
    });
    updateExcelFile(userId);
});


// /help command - Shows normal user commands
bot.onText(/\/help/, (msg) => {
    const helpText = `
Here are the available commands:

1. /start - Начать чат.
2. /balancecheck - Проверить Ваш баланс.
3. /changebalance <amount> - Запрос на изменение баланса (нужна верификация админа).
4. /loanget - Запрос на кредит.
5. /loanhistory me - Посмотреть Вашу кредитную историю.
6. /chatahuman <reason> - Чат с Админом
6. /chatagpt - чат с финансовым помощником 
7. /endchatagpt- завершить чат с помощнком
8. /payloan <id> <amount> - заплатить определенную сумму на активный кредит с ID
9. /payloan <id> - полностью погасить кредит
Для списка команд админов, используйте /ownercommands (Только Админы).
    `;

    bot.sendMessage(msg.from.id, helpText);
    updateExcelFile(userId);
});
// /ownercommands - Check for ownership and display owner commands
bot.onText(/\/ownercommands/, (msg) => {
    const userId = msg.from.id;

    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой команде.");
        
    }

    const adminCommands = `
Admin Commands:

1. /approve <loan_id> - Подтвердить запрос на кредит.
2. /decline <loan_id> <reason>- Отклонить запрос на кредит с причиной.
3. /chatapprove <request_id> - начать чат с пользователем для смены баланса.
4. /endchat - завершить чат.
5. /balanceapprovedchange <user_id> <amount> - изменить баланс человека.
6. /loanhistory <user_id> - просмотреть кредитную историю пользователя.
7. /allloanhistory- посмотреть базу данных всех кредитных историй.
8. /pendingrequests- посмотреть на все запросы для изменение баланса.
9. /usercheckbalance <user_id>- просматривает баланс пользователя.
10. /acceptchat <id> - принимает запрос на чат с помощью ID( чтобы его получить /checkchatrequests)
11. /checkchatrequests - показывает все запрос на чат с админом от всех пользователей
12. /humanchatend - заканчивает чат в /acceptchat команде
`
;

    bot.sendMessage(userId, adminCommands);
    updateExcelFile(userId);
});
bot.onText(/\/pendingrequests/, (msg) => {
    const userId = msg.from.id;

    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой команде.");
    }

    // Query pending requests
    db.all(`SELECT request_id, user_id, amount FROM balance_requests WHERE status = 'pending'`, [], (err, rows) => {
        if (err) {
            return bot.sendMessage(userId, "Error fetching pending requests.");
        }

        if (rows.length === 0) {
            return bot.sendMessage(userId, "Нет ожидающих запросов на изменение баланса.");
        }

        let pendingRequests = 'Pending Balance Change Requests:\n';
        rows.forEach(row => {
            pendingRequests += ` ID запроса: ${row.request_id}, ID пользователя: ${row.user_id}, Количество: ${row.amount}\n`;
        });

        bot.sendMessage(userId, pendingRequests);
    });
    updateExcelFile(userId);
});

function sendChunkedMessage(chatId, message) {
    const maxLength = 4096;
    
    // Split the message into chunks
    const chunks = [];
    for (let i = 0; i < message.length; i += maxLength) {
        chunks.push(message.substring(i, i + maxLength));
    }

    // Send each chunk as a separate message
    chunks.forEach(chunk => {
        bot.sendMessage(chatId, chunk);
    });
}
bot.onText(/\/loanhistory(?: (\d+))?/, (msg, match) => {
    const userId = msg.from.id;
    const targetUserId = match[1] ? parseInt(match[1]) : userId;

    if (targetUserId === userId || userId === ownerId) {
        // Query active loans
        db.all(`SELECT * FROM loans WHERE user_id = ? AND status = 'approved'`, [targetUserId], (err, activeLoans) => {
            if (err) {
                return bot.sendMessage(userId, "Error fetching loan history.");
            }

            let historyMessage = `User ID: ${targetUserId}\n\nАктивные кредиты:\n`;

            if (activeLoans.length === 0) {
                historyMessage += `Нет активных кредитов.\n`;
            } else {
                activeLoans.forEach(row => {
                    const amountWithInterest = row.amount + (row.amount * row.interest / 100);
                    historyMessage += `ID кредита: ${row.loan_id}, Количество: ${row.amount}, Сумма с процентами: ${amountWithInterest}, Срок: ${row.duration} months, Процентная ставка: ${row.interest}%, Финансовый статус: ${row.financial_status}, Запрошен в: ${row.requested_at}\n`;
                });
            }

            // Query pending loans
            db.all(`SELECT * FROM loans WHERE user_id = ? AND status = 'pending'`, [targetUserId], (err, pendingLoans) => {
                if (err) {
                    return bot.sendMessage(userId, "Error fetching loan history.");
                }

                historyMessage += `\nОжидающие кредиты:\n`;

                if (pendingLoans.length === 0) {
                    historyMessage += `Нет ожидающих запросов.\n`;
                } else {
                    pendingLoans.forEach(row => {
                        const amountWithInterest = row.amount + (row.amount * row.interest / 100);
                        historyMessage += `ID кредита: ${row.loan_id}, Количество: ${row.amount}, Сумма с процентами: ${amountWithInterest}, Срок: ${row.duration} months, Процентная ставка: ${row.interest}%, Финансовый статус: ${row.financial_status}, Запрошен в: ${row.requested_at}\n`;
                    });
                }

                // Query declined loans
                db.all(`SELECT * FROM loans WHERE user_id = ? AND status = 'declined'`, [targetUserId], (err, declinedLoans) => {
                    if (err) {
                        return bot.sendMessage(userId, "Error fetching loan history.");
                    }

                    historyMessage += `\nОтказанные кредиты:\n`;

                    if (declinedLoans.length === 0) {
                        historyMessage += `Нет отказанных кредитов.\n`;
                    } else {
                        declinedLoans.forEach(row => {
                            const amountWithInterest = row.amount + (row.amount * row.interest / 100);
                            historyMessage += `ID кредита: ${row.loan_id}, Количество: ${row.amount}, Сумма с процентами: ${amountWithInterest}, Срок: ${row.duration} months, Процентная ставка: ${row.interest}%, Причина отказа: ${row.decline_reason || 'пусто'}, Запрошен в: ${row.requested_at}\n`;
                        });
                    }

                    // Query repaid loans
                    db.all(`SELECT * FROM loans WHERE user_id = ? AND status = 'repaid'`, [targetUserId], (err, repaidLoans) => {
                        if (err) {
                            return bot.sendMessage(userId, "Error fetching repaid loan history.");
                        }

                        historyMessage += `\nПогашенные кредиты:\n`;

                        if (repaidLoans.length === 0) {
                            historyMessage += `Нет погашенных кредитов.\n`;
                        } else {
                            repaidLoans.forEach(row => {
                                const amountWithInterest = row.amount + (row.amount * row.interest / 100);
                                historyMessage += `ID кредита: ${row.loan_id}, Количество: ${row.amount}, Сумма с процентами: ${amountWithInterest}, Срок: ${row.duration} months, Процентная ставка: ${row.interest}%, Погашен: ${row.repaid_at}\n`;
                            });
                        }

                        // Send the final consolidated message to the user
                        sendChunkedMessage(userId, historyMessage);
                    });
                });
            });
        });
    } else {
        bot.sendMessage(userId, "У Вас нет доступа к этой команде.");
    }
    updateExcelFile(userId);
});
bot.onText(/\/payloan (\d+)(?: (\d+))?/, (msg, match) => {
    const userId = msg.from.id;
    const loanId = parseInt(match[1]);
    const paymentAmount = match[2] ? parseFloat(match[2]) : null;

    // Find the loan by ID and make sure it's active
    db.get(`SELECT * FROM loans WHERE loan_id = ? AND user_id = ? AND status = 'approved'`, [loanId, userId], (err, loan) => {
        if (err) {
            return bot.sendMessage(userId, "Ошибка при поиске кредита.");
        }

        if (!loan) {
            return bot.sendMessage(userId, "Активный кредит с этим ID не найден.");
        }

        // Calculate the remaining amount after the payment
        let remainingAmount = loan.remaining_amount || (loan.amount + (loan.amount * loan.interest / 100));
        let newRemainingAmount;

        // Determine the payment amount
        if (paymentAmount === null) {
            // Pay off the loan fully
            newRemainingAmount = 0;
        } else {
            // Check if the payment is valid
            if (paymentAmount <= 0) {
                return bot.sendMessage(userId, "Сумма платежа должна быть больше нуля.");
            }

            newRemainingAmount = remainingAmount - paymentAmount;

            if (newRemainingAmount < 0) {
                return bot.sendMessage(userId, `Вы пытаетесь переплатить. Осталось выплатить: ${remainingAmount}`);
            }
        }

        // Check the user's balance
        db.get(`SELECT balance FROM users WHERE user_id = ?`, [userId], (err, user) => {
            if (err || !user) {
                return bot.sendMessage(userId, "Ошибка при проверке баланса.");
            }

            const userBalance = user.balance;

            if (userBalance < (paymentAmount || remainingAmount)) {
                return bot.sendMessage(userId, "Недостаточно средств для погашения кредита.");
            }

            // If loan is fully repaid, update the status to 'repaid'
            if (newRemainingAmount === 0) {
                db.run(`UPDATE loans SET remaining_amount = 0, status = 'repaid', repaid_at = CURRENT_TIMESTAMP WHERE loan_id = ?`, [loanId], (err) => {
                    if (err) {
                        return bot.sendMessage(userId, "Ошибка при обновлении кредита.");
                    }

                    bot.sendMessage(userId, "Ваш кредит погашен."); // Notify the user
                });
            } else {
                // Update the remaining amount in the database
                db.run(`UPDATE loans SET remaining_amount = ? WHERE loan_id = ?`, [newRemainingAmount, loanId], (err) => {
                    if (err) {
                        return bot.sendMessage(userId, "Ошибка при обновлении кредита.");
                    }
                });
            }

            // Deduct the payment amount from the user's balance
            const amountToDeduct = paymentAmount || remainingAmount; // Full amount if no payment specified
            const newBalance = userBalance - amountToDeduct;
            db.run(`UPDATE users SET balance = ? WHERE user_id = ?`, [newBalance, userId], (err) => {
                if (err) {
                    return bot.sendMessage(userId, "Ошибка при обновлении баланса.");
                }

                bot.sendMessage(userId, `Платеж принят. Остаток по кредиту: ${newRemainingAmount}. Ваш текущий баланс: ${newBalance}.`);
            });
        });
    });
    updateExcelFile(userId);
});


// /allloanhistory - Admin only, shows all pending loans
bot.onText(/\/allloanhistory/, (msg) => {
    const userId = msg.from.id;

    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой команде.");
    }

    // Query all pending loans
    db.all(`SELECT * FROM loans WHERE status = 'pending'`, [], (err, rows) => {
        if (err) {
            return bot.sendMessage(userId, "Error fetching pending loan history.");
        }

        if (rows.length === 0) {
            return bot.sendMessage(userId, "Нету ожидающих кредитов.");
        }

        // Sort rows by user_id
        rows.sort((a, b) => a.user_id - b.user_id);

        let historyMessage = `Все существующие ожидающие кредиты:\n`;
        let currentUserId = null;

        rows.forEach(row => {
            if (row.user_id !== currentUserId) {
                // Add spacing before a new user section
                if (currentUserId !== null) {
                    historyMessage += `\n`; // space between user sections
                }
                currentUserId = row.user_id;
                historyMessage += `\n ID пользователя: ${currentUserId}\n\nОжидающие кредиты:\n`;
            }

            historyMessage += `ID кредита: ${row.loan_id}, Количество: ${row.amount}, Срок: ${row.duration} months, Процентная ставка: ${row.interest}%,Финансовый статус: ${row.financial_status},Запрошен в: ${row.requested_at}\n`;
        });
        sendChunkedMessage(userId, historyMessage);
        updateExcelFile(userId);
    });
});



// /usercheckbalance <user_id> - Owner command to check any user's balance
bot.onText(/\/usercheckbalance (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);

    // Check if the user is the owner
    if (userId !== ownerId) {
        return bot.sendMessage(userId, "У Вас нет доступа к этой команде.");
    }

    // Query the user's balance from the database
    db.get(`SELECT balance FROM users WHERE user_id = ?`, [targetUserId], (err, row) => {
        if (err || !row) {
            return bot.sendMessage(userId, "Error fetching user's balance or user not found.");
        }

        bot.sendMessage(userId, `Баланс пользователя ${targetUserId} сейчас: ${row.balance || 0}`);
    });
    updateExcelFile(userId);
});
const Groq = require('groq-sdk');

// Initialize Groq and Telegram Bot
const groq = new Groq({ apiKey: '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' }); // Replace with your actual Groq API key


// Track active conversations
const activeConversations = {};

// Function to fetch all loan data for a user
function fetchAllLoanData(userId, callback) {
    let loanData = '';
    
    // Fetch active loans
    db.all(`SELECT * FROM loans WHERE user_id = ? AND status = 'approved'`, [userId], (err, activeLoans) => {
        if (!err && activeLoans.length > 0) {
            loanData += 'Активные кредиты:\n';
            activeLoans.forEach(loan => {
                loanData += `ID кредита: ${loan.loan_id}, Количество: ${loan.amount}, Срок: ${loan.duration} months, Процентная ставка: ${loan.interest}%,Финансовый статус: ${loan.financial_status},Запрошен в: ${loan.requested_at}\n`;
            });
        }

        // Fetch pending loans
        db.all(`SELECT * FROM loans WHERE user_id = ? AND status = 'pending'`, [userId], (err, pendingLoans) => {
            if (!err && pendingLoans.length > 0) {
                loanData += '\nОжидающие кредиты:\n';
                pendingLoans.forEach(loan => {
                    loanData +=`ID кредита: ${loan.loan_id}, Количество: ${loan.amount}, Срок: ${loan.duration} months, Процентная ставка: ${loan.interest}%,Финансовый статус: ${loan.financial_status},Запрошен в: ${loan.requested_at}\n`;
                });
            }

            // Fetch declined loans
            db.all(`SELECT * FROM loans WHERE user_id = ? AND status = 'declined'`, [userId], (err, declinedLoans) => {
                if (!err && declinedLoans.length > 0) {
                    loanData += '\nОтказанные кредиты:\n';
                    declinedLoans.forEach(loan => {
                        loanData += `ID кредита: ${loan.loan_id}, Количество: ${loan.amount}, Срок: ${loan.duration} months, Процентная ставка: ${loan.interest}%,Финансовый статус: ${loan.financial_status}, Причина отказа: ${loan.decline_reason || 'None'}, ,Запрошен в: ${loan.requested_at}\n`;
                    });
                }

                // Call the callback with the complete loan data
                callback(loanData);
            });
        });
    });
}

// Enhanced Groq Chat Completion Function
async function getGroqChatCompletion(userMessage, loanData = null) {
    let systemMessage = "Ты финансовый помощник с базой данных о кредитной истории пользователя.Разговаривай с ним на языке на котором он разговаривает. Если он скажет /endchatagpt  попрощайся";

    // If we have loan data, provide it as additional context
    if (loanData) {
        systemMessage += ` Вот кредитная история пользователя: ${loanData}`;
    }

    return groq.chat.completions.create({
        messages: [
            {
                role: 'system',
                content: systemMessage,
            },
            {
                role: 'user',
                content: userMessage,
            },
        ],
        model: 'llama3-8b-8192',
    });
}

// Handle messages for GPT-enabled chat
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userMessage = msg.text;

    // Check if the conversation is active
    if (activeConversations[chatId]) {
        // Check if the user mentioned the word "loan"
        if (/кредит/i.test(userMessage)) {
            // Fetch all loan data for the user
            fetchAllLoanData(userId, async (loanData) => {
                // Get the response from Groq with loan data
                try {
                    const chatCompletion = await getGroqChatCompletion(userMessage, loanData);
                    const botResponse = chatCompletion.choices[0]?.message?.content || "Извините, я это не понял.";
                    
                    // Send the response back to the user
                    bot.sendMessage(chatId, botResponse);
                } catch (error) {
                    console.error('Error fetching Groq response:', error);
                    bot.sendMessage(chatId, "Произошла ошибка. Попробуйте еще раз.");
                }
            });
        } else {
            // If no "loan" mention, just pass the message directly to Groq
            try {
                const chatCompletion = await getGroqChatCompletion(userMessage);
                const botResponse = chatCompletion.choices[0]?.message?.content || "Извините, я это не понял.";
                
                // Send the response back to the user
                bot.sendMessage(chatId, botResponse);
            } catch (error) {
                console.error('Error fetching Groq response:', error);
                bot.sendMessage(chatId, "Произошла ошибка. Попробуйте еще раз.");
            }
        }
    }
});



// Start conversation command
bot.onText(/\/chatagpt/, (msg) => {
  const chatId = msg.chat.id;
  
  // Mark this chat as having an active conversation
  activeConversations[chatId] = true;
  
  bot.sendMessage(chatId, "Теперь Вы можете общаться со мной! Используйте /chatagptend чтобы завершить разговор.");
});

// Handle messages



// End conversation command
bot.onText(/\/endchatagpt/, (msg) => {
  const chatId = msg.chat.id;

  // Remove this chat from active conversations
  delete activeConversations[chatId];

  bot.sendMessage(chatId, "Разговор был завершен. Вы можете начать новый используя /chatagpt.");
});

// Start the bot
console.log('Telegram bot is running...');
// Function to send notifications for active loans
function notifyActiveLoans() {
    db.all(`SELECT * FROM loans WHERE status = 'approved'`, (err, loans) => {
        if (err) {
            return console.error("Error fetching loans:", err);
        }

        loans.forEach(loan => {
            const userId = loan.user_id;
            const remainingAmount = loan.remaining_amount || (loan.amount + (loan.amount * loan.interest / 100));

            let message = `Напоминание: У вас есть активный кредит.\n`;
            message += `ID кредита: ${loan.loan_id}\n`;
            message += `Общая сумма кредита с процентами: ${loan.amount + (loan.amount * loan.interest / 100)}\n`;
            message += `Осталось выплатить: ${remainingAmount}\n`;
            message += `Срок кредита: ${loan.duration} months\n`;
            message += `Процентная ставка: ${loan.interest}%\n`;

            bot.sendMessage(userId, message);
        });
    });
}

// Set an interval to check for active loans every minute
setInterval(notifyActiveLoans, 60 * 1000); // 60 seconds
function updateExcelFile(userId) {
    db.get(`SELECT balance FROM users WHERE user_id = ?`, [userId], (err, user) => {
        if (err || !user) return console.error("Error fetching user data:", err);

        const balance = user.balance || 0;

        // Get loans information
        db.all(`SELECT * FROM loans WHERE user_id = ?`, [userId], (err, loans) => {
            if (err) return console.error("Error fetching loan data:", err);

            const activeLoans = loans.filter(loan => loan.status === 'approved').map(loan => loan.loan_id);
            const declinedLoans = loans.filter(loan => loan.status === 'declined').map(loan => loan.loan_id);
            const pendingLoans = loans.filter(loan => loan.status === 'pending').map(loan => loan.loan_id);
            const repaidLoans = loans.filter(loan => loan.status === 'repaid').map(loan => loan.loan_id);

            // Create or update the new Excel file
            let workbook;
            let worksheet;
            try {
                workbook = xlsx.readFile('LOANDATA.xlsx');  // Use new file name
                worksheet = workbook.Sheets['Loans'];
            } catch (error) {
                // If file doesn't exist, create a new one
                workbook = xlsx.utils.book_new();
                worksheet = xlsx.utils.aoa_to_sheet([['USER ID', 'BALANCE', 'ACTIVE LOANS IDS', 'DECLINED LOANS IDS', 'PENDING LOANS ID', 'REPAID LOANS ID']]);
                xlsx.utils.book_append_sheet(workbook, worksheet, 'Loans');
            }

            const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

            // Check if user exists in the sheet
            const userIndex = data.findIndex(row => row[0] === userId);
            const row = [
                userId,
                balance,
                activeLoans.join(', '),
                declinedLoans.join(', '),
                pendingLoans.join(', '),
                repaidLoans.join(', ')
            ];

            if (userIndex !== -1) {
                // Update existing row
                data[userIndex] = row;
            } else {
                // Add new row
                data.push(row);
            }

            // Convert back to worksheet
            const newWorksheet = xlsx.utils.aoa_to_sheet(data);
            workbook.Sheets['Loans'] = newWorksheet;

            // Apply column width adjustments
            newWorksheet['!cols'] = [
                { wch: 10 },  // USER ID
                { wch: 10 },  // BALANCE
                { wch: 30 },  // ACTIVE LOANS IDS
                { wch: 30 },  // DECLINED LOANS IDS
                { wch: 30 },  // PENDING LOANS ID
                { wch: 30 }   // REPAID LOANS ID
            ];

            // Add some styling to the headers
            const headerStyle = {
                font: { bold: true, color: { rgb: "FFFFFF" } },  // White bold text
                fill: { fgColor: { rgb: "4F81BD" } },  // Blue background
                alignment: { horizontal: 'center', vertical: 'center' }
            };

            const headers = ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', ];
            headers.forEach(cell => {
                if (newWorksheet[cell]) newWorksheet[cell].s = headerStyle;
            });

            // Save the file
            xlsx.writeFile(workbook, 'LOANDATA.xlsx');

            // Log to console that the file has been updated
            console.log('FILE UPDATED NOW');
        });
    });
}

function updateExcelForAllUsers() {
    // Fetch all users from the database
    db.all(`SELECT user_id FROM users`, [], (err, users) => {
        if (err) {
            return console.error("Error fetching users:", err);
        }

        if (users.length === 0) {
            return console.log("No users found in the database.");
        }

        // Iterate over each user and update their info in the Excel file
        users.forEach(user => {
            updateExcelFile(user.user_id);  // Update the Excel file for each user
        });
    });
}

// Update the Excel file for all users every minute
setInterval(updateExcelForAllUsers, 60 * 1000);  // 60 seconds
