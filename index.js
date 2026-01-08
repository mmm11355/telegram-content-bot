const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const cron = require('node-cron');
const express = require('express');
const axios = require('axios');
const { addToSheet, getFromSheet, searchInSheet } = require('./sheets');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;

const bot = new TelegramBot(TELEGRAM_TOKEN);
const parser = new Parser();

const PORT = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL 
  ? `${process.env.RENDER_EXTERNAL_URL}/webhook`
  : `https://telegram-content-bot-nvhg.onrender.com/webhook`;

console.log('🤖 Бот запущен!');

const RSS_SOURCES = {
  'VC.ru': 'https://vc.ru/rss',
  'Habr': 'https://habr.com/ru/rss/all/all/',
  'Cossa': 'https://www.cossa.ru/rss/',
  'YouTube: Владилен Минин': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCg8ss4xW9jASrqWGP30jXiw',
  'YouTube: Гоша Дударь': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvuY904el7JvBlPbdqbfguw',
  'YouTube: WebForMyself': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCGuhp4lpQvK94ZC5kuOZbjA',
};

// Функция для запроса к Perplexity API
async function askPerplexity(prompt) {
  try {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'llama-3.1-sonar-small-128k-online',
        messages: [
          {
            role: 'system',
            content: 'Ты эксперт по автоматизации онлайн-школ, GetCourse, Prodamus и веб-разработке. Отвечай кратко, конкретно и только на русском языке.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 1500,
        temperature: 0.7,
        top_p: 0.9,
        return_citations: false
      },
      {
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('❌ Ошибка Perplexity API:', error.message);
    throw error;
  }
}

async function dailyDigest() {
  console.log('📊 Создаю дайджест...');
  
  try {
    const lastDigestTime = global.lastDigestTime || 0;
    const now = Date.now();
    const hourInMs = 60 * 60 * 1000;

    if (now - lastDigestTime < hourInMs) {
      console.log('⏳ Слишком частые запросы. Подождите 1 час.');
      await bot.sendMessage(CHANNEL_ID, '⏳ Дайджест можно создавать раз в час. Попробуйте позже.');
      return;
    }

    global.lastDigestTime = now;
    
    const allArticles = [];
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    console.log(`📅 Ищу материалы после: ${weekAgo.toLocaleDateString('ru-RU')}`);
    
    for (const [sourceName, rssUrl] of Object.entries(RSS_SOURCES)) {
      try {
        console.log(`📥 Парсинг: ${sourceName}...`);
        const feed = await parser.parseURL(rssUrl);
        
        if (!feed || !feed.items || feed.items.length === 0) {
          console.log(`⚠️ Нет материалов: ${sourceName}`);
          continue;
        }
        
        const recentArticles = feed.items
          .filter(item => {
            const pubDate = item.pubDate || item.isoDate;
            if (!pubDate) return true;
            const itemDate = new Date(pubDate);
            return itemDate >= weekAgo;
          })
          .slice(0, 10)
          .map(item => {
            const isYouTube = item.link?.includes('youtube.com');
            const pubDate = item.pubDate || item.isoDate;
            
            return {
              title: item.title || 'Без названия',
              link: item.link || '',
              source: sourceName,
              snippet: item.contentSnippet?.substring(0, 200) || 
                       item.content?.substring(0, 200) || 
                       item.description?.substring(0, 200) || '',
              type: isYouTube ? 'видео' : 'статья',
              pubDate: pubDate,
              dateFormatted: pubDate ? new Date(pubDate).toLocaleDateString('ru-RU') : 'Дата неизвестна'
            };
          });
        
        allArticles.push(...recentArticles);
        console.log(`✅ Добавлено ${recentArticles.length} свежих материалов из ${sourceName}`);
        
      } catch (error) {
        console.log(`❌ Ошибка парсинга ${sourceName}: ${error.message}`);
      }
    }
    
    if (allArticles.length === 0) {
      console.log('⚠️ Нет свежих материалов за последние 7 дней');
      await bot.sendMessage(CHANNEL_ID, '❌ За последнюю неделю нет новых материалов. Попробую позже!');
      return;
    }
    
    allArticles.sort((a, b) => {
      const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
      const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
      return dateB - dateA;
    });
    
    console.log(`📊 Всего свежих материалов за неделю: ${allArticles.length}`);
    
    // Используем Perplexity для создания дайджеста
    const digestPrompt = `Выбери ТОП-3 самых полезных материала из этого списка по темам автоматизация онлайн-школ, GetCourse, Prodamus, веб-разработка:

МАТЕРИАЛЫ:
${allArticles.slice(0, 20).map((a, i) => `
${i + 1}. ${a.type === 'видео' ? '🎥' : '📄'} ${a.title}
Источник: ${a.source}
Дата: ${a.dateFormatted}
Ссылка: ${a.link}
`).join('\n')}

Создай короткий пост для Telegram (максимум 1200 символов):

📰 ДАЙДЖЕСТ за неделю

Для каждого материала:
- Эмодзи + Название
- 1-2 предложения о практической ценности
- Ссылка

В конце: 💡 Главный тренд недели (1 предложение)

ТОЛЬКО НА РУССКОМ ЯЗЫКЕ, кратко и конкретно.`;

    const digest = await askPerplexity(digestPrompt);
    
    const finalDigest = `🗓️ ${weekAgo.toLocaleDateString('ru-RU')} - ${new Date().toLocaleDateString('ru-RU')}\n\n${digest}`;
    
    await bot.sendMessage(CHANNEL_ID, finalDigest, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    
    console.log('✅ Дайджест опубликован!');
    
  } catch (error) {
    console.error('❌ Ошибка в dailyDigest:', error.message);
    
    // Fallback: простой список если Perplexity не работает
    try {
      const allArticles = [];
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      
      for (const [sourceName, rssUrl] of Object.entries(RSS_SOURCES)) {
        try {
          const feed = await parser.parseURL(rssUrl);
          if (feed && feed.items) {
            const fresh = feed.items.filter(item => {
              const pubDate = item.pubDate || item.isoDate;
              if (!pubDate) return false;
              return new Date(pubDate) >= weekAgo;
            });
            
            allArticles.push(...fresh.slice(0, 5).map(item => ({
              title: item.title,
              link: item.link,
              source: sourceName,
              date: new Date(item.pubDate || item.isoDate).toLocaleDateString('ru-RU')
            })));
          }
        } catch (e) {}
      }
      
      allArticles.sort((a, b) => new Date(b.date) - new Date(a.date));
      
      let simpleDigest = `📰 ДАЙДЖЕСТ за неделю\n\n`;
      allArticles.slice(0, 10).forEach((a, i) => {
        simpleDigest += `${i + 1}. ${a.title}\n`;
        simpleDigest += `📅 ${a.date} | 📂 ${a.source}\n`;
        simpleDigest += `🔗 ${a.link}\n\n`;
      });
      
      await bot.sendMessage(CHANNEL_ID, simpleDigest);
      console.log('✅ Упрощенный дайджест отправлен');
      
    } catch (e) {
      await bot.sendMessage(CHANNEL_ID, '❌ Ошибка при создании дайджеста.');
    }
  }
}

async function generateIdeas() {
  console.log('💡 Генерирую идеи...');
  
  try {
    const prompt = `Сгенерируй 5 идей для контента на следующую неделю по темам:
- Автоматизация GetCourse
- Платежи Prodamus.XL
- Дизайн лендингов
- JavaScript скрипты
- Воронки продаж

Для каждой идеи:
1. Название (цепляющее, с цифрами)
2. Формат (статья/видео/чек-лист)
3. Практическая ценность (конкретный результат)

Оформи как пост для Telegram с эмодзи, НА РУССКОМ ЯЗЫКЕ, максимум 1500 символов.`;

    const ideas = await askPerplexity(prompt);
    
    await bot.sendMessage(CHANNEL_ID, `💡 ИДЕИ КОНТЕНТА НА НЕДЕЛЮ\n\n${ideas}`, {
      parse_mode: 'Markdown'
    });
    
    console.log('✅ Идеи опубликованы!');
    
  } catch (error) {
    console.error('❌ Ошибка в generateIdeas:', error.message);
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `👋 Привет! Я AI-помощник по автоматизации GetCourse и Prodamus.

**Команды:**
/digest - получить дайджест за неделю
/ideas - сгенерировать идеи контента
/stats - статистика базы

**Автоматически:**
📅 Каждый день в 9:00 - дайджест
💡 Каждый понедельник в 10:00 - идеи контента

Работаю на Perplexity AI 🚀`
  );
});

bot.onText(/\/digest/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Создаю дайджест...');
  await dailyDigest();
  await bot.sendMessage(msg.chat.id, '✅ Готово! Проверьте канал.');
});

bot.onText(/\/ideas/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Генерирую идеи...');
  await generateIdeas();
  await bot.sendMessage(msg.chat.id, '✅ Готово! Проверьте канал.');
});

bot.onText(/\/stats/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '📊 Получаю статистику...');
  
  try {
    const allData = await getFromSheet();
    
    if (allData.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ База данных пуста.');
      return;
    }
    
    let stats = `📊 СТАТИСТИКА\n\n📚 Всего материалов: ${allData.length}`;
    await bot.sendMessage(msg.chat.id, stats);
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка: ' + error.message);
  }
});

cron.schedule('0 9 * * *', () => {
  console.log('⏰ Время дайджеста!');
  dailyDigest();
}, {
  timezone: "Asia/Yakutsk"
});

cron.schedule('0 10 * * 1', () => {
  console.log('⏰ Генерирую идеи на неделю!');
  generateIdeas();
}, {
  timezone: "Asia/Yakutsk"
});

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('🤖 GetCourse бот работает на Perplexity AI!');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  
  bot.setWebHook(WEBHOOK_URL)
    .then(() => {
      console.log('✅ Webhook установлен:', WEBHOOK_URL);
      console.log('🤖 Бот полностью запущен!');
      console.log('🚀 Работаю на Perplexity AI');
    })
    .catch((err) => {
      console.error('❌ Ошибка webhook:', err.message);
    });
});
