const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const TelegramBot = require('node-telegram-bot-api');
const net = require('net');
require('dotenv').config();

// Конфигурация
const config = {
    minecraft: {
        host: process.env.MC_HOST || 'cis_land.aternos.me',
        port: parseInt(process.env.MC_PORT) || 29993,
        username: process.env.MC_USERNAME || 'AFKBot',
        version: process.env.MC_VERSION || '1.20.1'
    },
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN || '8217202606:AAH6xOeUt3nt9Ogc_WAXsaw2DsvpgpCAShA',
        chatId: process.env.TELEGRAM_CHAT_ID || '5233967167'
    }
};

class MinecraftAFKBot {
    constructor() {
        this.bot = null;
        this.isConnected = false;
        this.telegramBot = new TelegramBot(config.telegram.token, { polling: true });
        this.afkInterval = null;
        this.followInterval = null;
        this.isFollowing = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5; // Максимум 5 попыток
        this.baseReconnectDelay = 10000; // Начальная задержка 10 секунд
        this.setupTelegramCommands();
    }

    // Проверка доступности сервера
    async checkServerAvailability() {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            const timeout = 5000;
            client.setTimeout(timeout);

            client.connect(config.minecraft.port, config.minecraft.host, () => {
                resolve(true);
                client.destroy();
            });

            client.on('error', (err) => {
                resolve(false);
                client.destroy();
            });

            client.on('timeout', () => {
                resolve(false);
                client.destroy();
            });
        });
    }

    // Подключение к Minecraft серверу
    async connectToMinecraft() {
        this.sendTelegramMessage('🔄 Проверяю доступность сервера...');

        const isAvailable = await this.checkServerAvailability();

        if (!isAvailable) {
            this.sendTelegramMessage('❌ Сервер недоступен. Пожалуйста, запустите его в панели Aternos (aternos.org) и попробуйте снова через /connect.');
            return;
        }

        this.sendTelegramMessage('✅ Сервер доступен. Подключаюсь к серверу Minecraft...');

        this.bot = mineflayer.createBot({
            host: config.minecraft.host,
            port: config.minecraft.port,
            username: config.minecraft.username,
            version: config.minecraft.version,
            auth: 'offline',
            skipValidation: true,
            hideErrors: false,
            checkTimeoutInterval: 30 * 1000,
            keepAlive: true
        });

        this.bot.loadPlugin(pathfinder);
        this.setupMinecraftEvents();
    }

    // Автоматическое переподключение
    async attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.sendTelegramMessage('❌ Превышено максимальное количество попыток переподключения. Используйте /connect для повторной попытки после запуска сервера.');
            this.reconnectAttempts = 0;
            return;
        }

        const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), 60000); // Экспоненциальная задержка, макс. 60 секунд
        this.reconnectAttempts++;
        this.sendTelegramMessage(`🔄 Попытка переподключения ${this.reconnectAttempts}/${this.maxReconnectAttempts} через ${delay/1000} секунд...`);

        setTimeout(async () => {
            const isAvailable = await this.checkServerAvailability();
            if (!isAvailable) {
                this.sendTelegramMessage('❌ Сервер всё ещё недоступен. Проверяю снова...');
                this.attemptReconnect();
                return;
            }

            await this.connectToMinecraft();
        }, delay);
    }

    // События Minecraft бота
    setupMinecraftEvents() {
        this.bot.on('login', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0; // Сбрасываем счётчик при успешном подключении
            console.log(`Подключен как ${this.bot.username}`);
            this.sendTelegramMessage(`✅ Успешно подключен к серверу как ${this.bot.username}`);
            this.startAFKMode();
        });

        this.bot.on('spawn', () => {
            console.log('Заспавнился на сервере');
            this.sendTelegramMessage('🎮 Заспавнился на сервере, начинаю AFK режим');
            const defaultMove = new Movements(this.bot);
            this.bot.pathfinder.setMovements(defaultMove);
        });

        this.bot.on('chat', (username, message) => {
            if (username === this.bot.username) return;
            console.log(`<${username}> ${message}`);
            if (message.includes(this.bot.username) || message.includes('@') || message.includes('админ')) {
                this.sendTelegramMessage(`💬 Сообщение от ${username}: ${message}`);
            }
        });

        this.bot.on('whisper', (username, message) => {
            console.log(`${username} шепчет: ${message}`);
            this.sendTelegramMessage(`👤 Приватное сообщение от ${username}: ${message}`);
        });

        this.bot.on('health', () => {
            if (this.bot.health < 10) {
                this.sendTelegramMessage(`⚠️ Здоровье низкое: ${this.bot.health}/20`);
            }
        });

        this.bot.on('death', () => {
            console.log('Бот умер');
            this.sendTelegramMessage('💀 Бот умер! Пытаюсь возродиться...');
            this.stopFollowing();
            setTimeout(() => {
                if (this.bot) {
                    this.bot.chat('/spawn');
                }
            }, 3000);
        });

        this.bot.on('kicked', (reason) => {
            console.log(`Кикнут с сервера: ${reason}`);
            this.sendTelegramMessage(`👮 Кикнут с сервера: ${reason}`);
            this.isConnected = false;
            this.stopFollowing();
            this.attemptReconnect();
        });

        this.bot.on('error', (err) => {
            console.error('Ошибка бота:', err);
            this.sendTelegramMessage(`❌ Ошибка бота: ${err.message}`);
            this.isConnected = false;
            this.stopFollowing();
            this.attemptReconnect();
        });

        this.bot.on('end', (reason) => {
            console.log('Соединение закрыто:', reason);
            this.sendTelegramMessage(`🔌 Соединение с сервером закрыто: ${reason || 'неизвестная причина'}`);
            this.isConnected = false;
            this.stopAFKMode();
            this.stopFollowing();
            if (reason !== 'disconnect.quitting') {
                this.attemptReconnect();
            }
        });
    }

    // AFK режим
    startAFKMode() {
        this.afkInterval = setInterval(() => {
            if (this.isConnected && this.bot && !this.isFollowing) {
                this.bot.look(
                    this.bot.entity.yaw + (Math.random() - 0.5) * 0.1,
                    this.bot.entity.pitch + (Math.random() - 0.5) * 0.1
                );
                if (Math.random() < 0.1) {
                    this.bot.setControlState('jump', true);
                    setTimeout(() => {
                        if (this.bot) {
                            this.bot.setControlState('jump', false);
                        }
                    }, 100);
                }
            }
        }, 30000);
    }

    stopAFKMode() {
        if (this.afkInterval) {
            clearInterval(this.afkInterval);
            this.afkInterval = null;
        }
    }

    // Следование за игроком
    followPlayer(playerName) {
        const player = this.bot.players[playerName];
        if (!player) {
            this.sendTelegramMessage(`❌ Игрок ${playerName} не найден на сервере`);
            return;
        }

        this.isFollowing = true;
        this.stopAFKMode();
        this.sendTelegramMessage(`🚶 Начинаю следовать за ${playerName}`);

        this.followInterval = setInterval(() => {
            if (!this.isConnected || !this.bot || !this.isFollowing) return;

            const target = this.bot.players[playerName]?.entity;
            if (!target) {
                this.sendTelegramMessage(`❌ Игрок ${playerName} больше не на сервере`);
                this.stopFollowing();
                return;
            }

            const { x, y, z } = target.position;
            const goal = new goals.GoalNear(x, y, z, 2);
            this.bot.pathfinder.setGoal(goal);
        }, 1000);
    }

    stopFollowing() {
        if (this.followInterval) {
            clearInterval(this.followInterval);
            this.followInterval = null;
        }
        this.isFollowing = false;
        if (this.bot && this.isConnected) {
            this.bot.pathfinder.setGoal(null);
            this.startAFKMode();
        }
        this.sendTelegramMessage('🛑 Прекратил следование за игроком');
    }

    // Настройка команд Telegram бота
    setupTelegramCommands() {
        this.telegramBot.onText(/\/start/, (msg) => {
            const welcomeMessage = `
🤖 Добро пожаловать в управление Minecraft AFK ботом!

Доступные команды:
/connect - Подключиться к серверу
/disconnect - Отключиться от сервера
/reconnect - Переподключиться
/ping - Проверить доступность сервера
/status - Статус бота
/pos - Координаты
/health - Здоровье и голод
/players - Список игроков
/say <текст> - Написать в чат
/tp <игрок> - Телепорт к игроку
/follow <ник> - Следовать за игроком
/stopfollow - Прекратить следование
/help - Показать помощь
            `;
            this.telegramBot.sendMessage(msg.chat.id, welcomeMessage);
        });

        this.telegramBot.onText(/\/connect/, async (msg) => {
            if (!this.isConnected) {
                this.reconnectAttempts = 0; // Сбрасываем попытки при ручном /connect
                await this.connectToMinecraft();
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '✅ Бот уже подключен к серверу');
            }
        });

        this.telegramBot.onText(/\/reconnect/, (msg) => {
            if (this.isConnected && this.bot) {
                this.bot.quit('Переподключение...');
            }
            this.reconnectAttempts = 0;
            setTimeout(() => {
                this.connectToMinecraft();
            }, 2000);
        });

        this.telegramBot.onText(/\/ping/, async (msg) => {
            this.sendTelegramMessage('🏓 Проверяю сервер...');
            const isAvailable = await this.checkServerAvailability();
            if (isAvailable) {
                this.telegramBot.sendMessage(msg.chat.id, `✅ Сервер ${config.minecraft.host} доступен`);
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Сервер недоступен (оффлайн или тайм-аут)');
            }
        });

        this.telegramBot.onText(/\/disconnect/, (msg) => {
            if (this.isConnected && this.bot) {
                this.bot.quit('Отключен через Telegram');
                this.sendTelegramMessage('👋 Отключился от сервера');
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Бот не подключен к серверу');
            }
        });

        this.telegramBot.onText(/\/status/, (msg) => {
            if (this.isConnected && this.bot) {
                const status = `
🟢 Статус: Онлайн
🎮 Сервер: ${config.minecraft.host}
👤 Ник: ${this.bot.username}
❤️ Здоровье: ${this.bot.health}/20
🍖 Голод: ${this.bot.food}/20
📍 Позиция: ${Math.floor(this.bot.entity.position.x)}, ${Math.floor(this.bot.entity.position.y)}, ${Math.floor(this.bot.entity.position.z)}
                `;
                this.telegramBot.sendMessage(msg.chat.id, status);
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '🔴 Статус: Офлайн');
            }
        });

        this.telegramBot.onText(/\/say (.+)/, (msg, match) => {
            if (this.isConnected && this.bot) {
                const message = match[1];
                this.bot.chat(message);
                this.telegramBot.sendMessage(msg.chat.id, `📢 Отправлено в чат: ${message}`);
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Бот не подключен к серверу');
            }
        });

        this.telegramBot.onText(/\/tp (.+)/, (msg, match) => {
            if (this.isConnected && this.bot) {
                const playerName = match[1];
                this.bot.chat(`/tp ${playerName}`);
                this.telegramBot.sendMessage(msg.chat.id, `🚀 Телепортируюсь к ${playerName}`);
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Бот не подключен к серверу');
            }
        });

        this.telegramBot.onText(/\/pos/, (msg) => {
            if (this.isConnected && this.bot) {
                const pos = this.bot.entity.position;
                const message = `📍 Координаты: X: ${Math.floor(pos.x)}, Y: ${Math.floor(pos.y)}, Z: ${Math.floor(pos.z)}`;
                this.telegramBot.sendMessage(msg.chat.id, message);
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Бот не подключен к серверу');
            }
        });

        this.telegramBot.onText(/\/health/, (msg) => {
            if (this.isConnected && this.bot) {
                const message = `❤️ Здоровье: ${this.bot.health}/20\n🍖 Голод: ${this.bot.food}/20`;
                this.telegramBot.sendMessage(msg.chat.id, message);
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Бот не подключен к серверу');
            }
        });

        this.telegramBot.onText(/\/players/, (msg) => {
            if (this.isConnected && this.bot) {
                const players = Object.keys(this.bot.players).filter(name => name !== this.bot.username);
                const message = players.length > 0 
                    ? `👥 Игроки онлайн (${players.length}): ${players.join(', ')}`
                    : '👥 На сервере нет других игроков';
                this.telegramBot.sendMessage(msg.chat.id, message);
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Бот не подключен к серверу');
            }
        });

        this.telegramBot.onText(/\/follow (.+)/, (msg, match) => {
            if (this.isConnected && this.bot) {
                const playerName = match[1];
                this.followPlayer(playerName);
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Бот не подключен к серверу');
            }
        });

        this.telegramBot.onText(/\/stopfollow/, (msg) => {
            if (this.isConnected && this.bot && this.isFollowing) {
                this.stopFollowing();
            } else {
                this.telegramBot.sendMessage(msg.chat.id, '❌ Бот не следует за игроком или не подключен');
            }
        });

        this.telegramBot.onText(/\/help/, (msg) => {
            const helpMessage = `
🆘 Помощь по командам:

🔌 Подключение:
/connect - Подключиться к серверу
/disconnect - Отключиться от сервера
/reconnect - Переподключиться
/ping - Проверить доступность сервера

📊 Информация:
/status - Статус бота
/pos - Координаты
/health - Здоровье и голод
/players - Список игроков

🎮 Действия:
/say <текст> - Написать в чат
/tp <игрок> - Телепорт к игроку
/follow <ник> - Следовать за игроком
/stopfollow - Прекратить следование

ℹ️ Бот автоматически переподключается при кике или сбое (до 5 попыток). Если сервер оффлайн, запустите его в панели Aternos!
            `;
            this.telegramBot.sendMessage(msg.chat.id, helpMessage);
        });
    }

    sendTelegramMessage(message) {
        if (config.telegram.chatId && config.telegram.chatId !== 'YOUR_CHAT_ID') {
            this.telegramBot.sendMessage(config.telegram.chatId, message);
        }
    }

    start() {
        console.log('🤖 Minecraft AFK Bot запущен!');
        console.log('📱 Telegram бот готов к работе');
        this.sendTelegramMessage('🚀 Minecraft AFK Bot запущен! Используйте /help для просмотра команд');
    }
}

const afkBot = new MinecraftAFKBot();
afkBot.start();

process.on('SIGINT', () => {
    console.log('Закрытие бота...');
    if (afkBot.bot) {
        afkBot.bot.quit('Бот выключен');
    }
    process.exit(0);
});