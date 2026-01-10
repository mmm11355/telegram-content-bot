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

// ========== RSS ИСТОЧНИКИ ==========
const RSS_SOURCES = {
   // Основные новости
  'VC.ru': 'https://vc.ru/rss',
  'Habr': 'https://habr.com/ru/rss/all/all/',
  'Habr Веб-разработка': 'https://habr.com/ru/rss/hub/webdev/all/',
  'Cossa': 'https://www.cossa.ru/rss/',

  // Telegram каналы
  'TG: sites_layout': 'https://rsshub.app/telegram/channel/sites_layout',
  'TG: getcourse_update_blog': 'https://rsshub.app/telegram/channel/getcourse_update_blog',
  'TG: help0340ru': 'https://rsshub.app/telegram/channel/help0340ru',
  'TG: getstart_pro': 'https://rsshub.app/telegram/channel/getstart_pro',
  'TG: designGC': 'https://rsshub.app/telegram/channel/designGC',
  'TG: onewaydev': 'https://rsshub.app/telegram/channel/onewaydev',
  'TG: GetCourseProfi': 'https://rsshub.app/telegram/channel/GetCourseProfi',
  'TG: headjek_xl': 'https://rsshub.app/telegram/channel/headjek_xl',
  'TG: tatyankati_botaxl': 'https://rsshub.app/telegram/channel/tatyankati_botaxl',
  'TG: slowcountry': 'https://rsshub.app/telegram/channel/slowcountry',
  
  // YouTube каналы
  'YouTube: Владилен Минин': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCg8ss4xW9jASrqWGP30jXiw',
  'YouTube: Гоша Дударь': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvuY904el7JvBlPbdqbfguw',
  'YouTube: WebForMyself': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCGuhp4lpQvK94ZC5kuOZbjA',
  'YouTube: Анна Блок': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCn5wduCq2Mus0v85QZn9IaA',
};


// ========== PERPLEXITY API ==========
async function askPerplexity(prompt) {
  try {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'Ты эксперт по автоматизации онлайн-школ, GetCourse, Prodamus.XL, веб-разработке и дизайну. Отвечай кратко, конкретно, только на русском.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 1500,
        temperature: 0.7,
        top_p: 0.9
      },
      {
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('❌ Ошибка Perplexity:', error.response?.status, error.response?.data || error.message);
    throw new Error('Ошибка API Perplexity. Проверьте ключ и баланс.');
  }
}

// ========== ДАЙДЖЕСТ ==========
async function dailyDigest(targetChatId = null) {
  console.log('📊 Создаю дайджест...');
  
  const chatId = targetChatId || CHANNEL_ID;
  
  try {
    const lastDigestTime = global.lastDigestTime || 0;
    const now = Date.now();
    const hourInMs = 60 * 60 * 1000;

    if (now - lastDigestTime < hourInMs && !targetChatId) {
      console.log('⏳ Слишком частые запросы.');
      await bot.sendMessage(chatId, '⏳ Дайджест можно создавать раз в час.');
      return;
    }

    if (!targetChatId) {
      global.lastDigestTime = now;
    }
    
    const allArticles = [];
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    console.log(`📅 Период: ${weekAgo.toLocaleDateString('ru-RU')} - ${new Date().toLocaleDateString('ru-RU')}`);
    
    for (const [sourceName, rssUrl] of Object.entries(RSS_SOURCES)) {
      try {
        console.log(`📥 Парсинг: ${sourceName}...`);
        const feed = await parser.parseURL(rssUrl);
        
        if (!feed || !feed.items || feed.items.length === 0) {
          console.log(`⚠️ Нет данных: ${sourceName}`);
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
          .map(item => ({
            title: item.title || 'Без названия',
            link: item.link || '',
            source: sourceName,
            snippet: item.contentSnippet?.substring(0, 300) || 
                     item.content?.substring(0, 300) || 
                     item.description?.substring(0, 300) || '',
            type: item.link?.includes('youtube.com') ? '🎥 Видео' : '📄 Статья',
            pubDate: item.pubDate || item.isoDate,
            dateFormatted: item.pubDate ? new Date(item.pubDate || item.isoDate).toLocaleDateString('ru-RU') : 'Дата н/д'
          }));
        
        allArticles.push(...recentArticles);
        console.log(`✅ Добавлено ${recentArticles.length} из ${sourceName}`);
        
      } catch (error) {
        console.log(`❌ Ошибка ${sourceName}: ${error.message}`);
      }
    }
    
    if (allArticles.length === 0) {
      console.log('⚠️ Нет свежих материалов');
      await bot.sendMessage(chatId, '❌ Нет новых материалов за неделю.');
      return;
    }
    
    console.log(`📊 Всего спарсено: ${allArticles.length}`);
    
    const keywords = [
      'getcourse', 'геткурс', 'prodamus', 'продамус',
      'онлайн-школ', 'онлайн курс', 'edtech',
      'лендинг', 'landing', 'tilda', 'тильда',
      'личный кабинет', 'кабинет', 'dashboard',
      'кастомизац', 'дизайн', 'ui/ux',
      'javascript', 'скрипт', 'webhook', 'api',
      'автоматизац', 'интеграц',
      'платеж', 'оплат', 'email', 'рассылк',
      'crm', 'воронк', 'бот', 'telegram',
      'аналитика', 'метрика', 'конверсия'
    ];
    
    const relevantArticles = allArticles.filter(article => {
      const text = (article.title + ' ' + article.snippet).toLowerCase();
      return keywords.some(keyword => text.includes(keyword.toLowerCase()));
    });
    
    console.log(`🎯 Релевантных: ${relevantArticles.length}`);
    
    if (relevantArticles.length < 5) {
      const softKeywords = ['веб-разработк', 'frontend', 'backend', 'react', 'node.js', 'css', 'дизайн', 'ui', 'ux'];
      const additionalArticles = allArticles.filter(article => {
        if (relevantArticles.includes(article)) return false;
        const text = (article.title + ' ' + article.snippet).toLowerCase();
        return softKeywords.some(keyword => text.includes(keyword.toLowerCase()));
      });
      relevantArticles.push(...additionalArticles.slice(0, 10));
    }
    
    if (relevantArticles.length === 0) {
      await bot.sendMessage(chatId, '❌ Нет материалов по вашей теме.');
      return;
    }
    
    relevantArticles.sort((a, b) => {
      const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
      const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
      return dateB - dateA;
    });
    
    const bySource = {};
    relevantArticles.forEach(article => {
      if (!bySource[article.source]) bySource[article.source] = [];
      bySource[article.source].push(article);
    });
    
    const selectedArticles = [];
    Object.keys(bySource).forEach(source => {
      const top3 = bySource[source].slice(0, 3);
      selectedArticles.push(...top3);
    });
    
    let digest = `📰 ДАЙДЖЕСТ: GetCourse и Prodamus.XL\n`;
    digest += `📅 ${weekAgo.toLocaleDateString('ru-RU')} - ${new Date().toLocaleDateString('ru-RU')}\n\n`;
    digest += `**Материалы (${selectedArticles.length}):**\n\n`;
    
    const groupedForDisplay = {};
    selectedArticles.forEach(article => {
      if (!groupedForDisplay[article.source]) groupedForDisplay[article.source] = [];
      groupedForDisplay[article.source].push(article);
    });
    
    Object.entries(groupedForDisplay).forEach(([source, articles]) => {
      digest += `**${source}:**\n`;
      articles.forEach((article, idx) => {
        digest += `${idx + 1}. ${article.type} ${article.title}\n`;
        digest += `   📅 ${article.dateFormatted}\n`;
        digest += `   🔗 ${article.link}\n\n`;
      });
    });
    
    const maxLength = 4000;
    const messages = [];
    let currentMessage = '';
    
    digest.split('\n\n').forEach(paragraph => {
      if ((currentMessage + paragraph).length > maxLength) {
        messages.push(currentMessage);
        currentMessage = paragraph + '\n\n';
      } else {
        currentMessage += paragraph + '\n\n';
      }
    });
    
    if (currentMessage) messages.push(currentMessage);
    
    for (const msg of messages) {
      await bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    }
    
    console.log('✅ Дайджест опубликован!');
    
    // Сохранение в Google Sheets (только для автоматических дайджестов)
    if (!targetChatId) {
      try {
        for (let i = 0; i < Math.min(selectedArticles.length, 10); i++) {
          const article = selectedArticles[i];
          const text = (article.title + ' ' + article.snippet).toLowerCase();
          
          let category = 'Разработка';
          if (text.includes('getcourse')) category = 'GetCourse';
          else if (text.includes('prodamus')) category = 'Prodamus';
          else if (text.includes('landing') || text.includes('лендинг')) category = 'Лендинги';
          else if (text.includes('кабинет')) category = 'Личный кабинет';
          else if (text.includes('дизайн')) category = 'Дизайн';
          else if (text.includes('скрипт') || text.includes('javascript')) category = 'Скрипты';
          else if (text.includes('бот')) category = 'Боты';
          else if (text.includes('api')) category = 'Автоматизация';
          
          await addToSheet({
            date: article.dateFormatted,
            source: article.source,
            title: article.title,
            url: article.link,
            keywords: 'getcourse, prodamus, автоматизация',
            category: category,
            analysis: article.snippet.substring(0, 200),
            idea: 'Из дайджеста'
          });
        }
        console.log('✅ Сохранено в Google Sheets');
      } catch (err) {
        console.log('⚠️ Ошибка Google Sheets:', err.message);
      }
    }
    
  } catch (error) {
    console.error('❌ Ошибка дайджеста:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при создании дайджеста: ' + error.message);
  }
}

// ========== ГЕНЕРАЦИЯ ИДЕЙ ==========
async function generateIdeas(targetChatId = null) {
  console.log('💡 Генерирую идеи...');
  
  const chatId = targetChatId || CHANNEL_ID;
  
  try {
    const prompt = `Сгенерируй 5 идей для постов/видео на неделю:

ТЕМЫ:
1. Автоматизация GetCourse и Prodamus.XL
2. Дизайн лендингов (Tilda)
3. Личные кабинеты GetCourse
4. JavaScript скрипты
5. Платежи Prodamus.XL

Для каждой идеи:
1. **Название** (конкретное, с цифрами)
2. **Формат** (пост/видео/кейс)
3. **Польза** (результат для читателя)

Максимум 1200 символов. ТОЛЬКО НА РУССКОМ.`;

    const ideas = await askPerplexity(prompt);
    
    await bot.sendMessage(chatId, `💡 ИДЕИ КОНТЕНТА НА НЕДЕЛЮ\n\n${ideas}`, {
      parse_mode: 'Markdown'
    });
    
    console.log('✅ Идеи опубликованы!');
    
  } catch (error) {
    console.error('❌ Ошибка генерации идей:', error.message);
    await bot.sendMessage(chatId, '❌ Ошибка генерации идей: ' + error.message);
  }
}

// ========== КОМАНДЫ БОТА ==========
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `👋 Привет! Я AI-помощник по автоматизации GetCourse и Prodamus.XL.

**Команды:**
/digest - дайджест материалов сейчас
/ideas - сгенерировать 5 идей для контента
/stats - статистика базы материалов  
/analyze [URL] - проанализировать статью или лендинг
/search [слово] - поиск в базе знаний

**Примеры:**
• /analyze https://www.cossa.ru/trends/346066/
• /search getcourse

**Автоматически:**
📅 Каждый день в 9:00 - дайджест
💡 Каждый понедельник в 10:00 - идеи контента
📊 Всё сохраняется в Google Таблицу

**Тематика:**
• Автоматизация GetCourse и Prodamus.XL
• Кастомизация личных кабинетов
• Создание лендингов и продающих сайтов
• Скрипты для онлайн-платформ

🚀 Powered by Perplexity AI`
  );
});

bot.onText(/\/digest/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳ Создаю дайджест...');
  await dailyDigest(chatId);
});

bot.onText(/\/ideas/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳ Генерирую идеи...');
  await generateIdeas(chatId);
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '📊 Получаю статистику...');
  
  try {
    const allData = await getFromSheet();
    
    if (allData.length === 0) {
      await bot.sendMessage(chatId, '❌ База пуста.');
      return;
    }
    
    const categories = {};
    const sources = {};
    
    allData.forEach(row => {
      const cat = row.category || 'Без категории';
      const src = row.source || 'Неизвестно';
      
      categories[cat] = (categories[cat] || 0) + 1;
      sources[src] = (sources[src] || 0) + 1;
    });
    
    let stats = `📊 СТАТИСТИКА БАЗЫ ЗНАНИЙ\n\n`;
    stats += `📚 Всего материалов: ${allData.length}\n\n`;
    
    stats += `**По категориям:**\n`;
    Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        stats += `• ${cat}: ${count}\n`;
      });
    
    stats += `\n**По источникам (топ-5):**\n`;
    Object.entries(sources)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([src, count]) => {
        stats += `• ${src}: ${count}\n`;
      });
    
    await bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('❌ Ошибка stats:', error);
    await bot.sendMessage(chatId, '❌ Ошибка: ' + error.message);
  }
});

bot.onText(/\/analyze (.+)/, async (msg, match) => {
  const url = match[1];
  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId, '🔍 Анализирую статью...');
  
  try {
    const response = await axios.get(url, { 
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const html = response.data;
    
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3000);
    
    if (!text || text.length < 100) {
      await bot.sendMessage(chatId, '❌ Не удалось извлечь текст статьи.');
      return;
    }
    
    const prompt = `Проанализируй эту статью для онлайн-школ/GetCourse/Prodamus:

URL: ${url}

ТЕКСТ:
${text}

ЗАДАЧА:
1. **Главная идея** (1-2 предложения)
2. **Применение для GetCourse/Prodamus** (конкретные действия)
3. **Ключевые инсайты** (3-5 пунктов)
4. **Идеи контента** (2-3 идеи для постов/видео)

Формат: краткий, структурированный, НА РУССКОМ, максимум 800 символов.`;

    const analysis = await askPerplexity(prompt);
    
    const result = `📊 АНАЛИЗ СТАТЬИ\n\n${analysis}\n\n🔗 ${url}`;
    
    await bot.sendMessage(chatId, result, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    
    try {
      await addToSheet({
        date: new Date().toLocaleDateString('ru-RU'),
        source: 'Manual Analysis',
        title: 'Анализ статьи',
        url: url,
        keywords: 'анализ, getcourse, prodamus',
        category: 'Анализ',
        analysis: analysis.substring(0, 200),
        idea: 'Проанализировано вручную'
      });
      
      await bot.sendMessage(chatId, '✅ Анализ сохранен в Google Таблицы!');
    } catch (err) {
      console.log('⚠️ Не удалось сохранить:', err.message);
    }
    
    console.log(`✅ Анализ: ${url}`);
    
  } catch (error) {
    console.error('❌ Ошибка анализа:', error.message);
    await bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`);
  }
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const query = match[1];
  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId, `🔍 Ищу "${query}" в базе знаний...`);
  
  try {
    const results = await searchInSheet(query);
    
    if (!results || results.length === 0) {
      await bot.sendMessage(chatId, `❌ Ничего не найдено по запросу "${query}"`);
      return;
    }
    
    let response = `🔍 РЕЗУЛЬТАТЫ ПОИСКА: "${query}"\n\n`;
    response += `Найдено: ${results.length}\n\n`;
    
    results.slice(0, 10).forEach((item, idx) => {
      response += `${idx + 1}. **${item.title}**\n`;
      response += `   📂 ${item.category} | 📅 ${item.date}\n`;
      response += `   🔗 ${item.url}\n\n`;
    });
    
    if (results.length > 10) {
      response += `\n... и еще ${results.length - 10} результатов`;
    }
    
    await bot.sendMessage(chatId, response, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    
    console.log(`✅ Поиск "${query}": найдено ${results.length}`);
    
  } catch (error) {
    console.error('❌ Ошибка поиска:', error.message);
    await bot.sendMessage(chatId, '❌ Ошибка поиска: ' + error.message);
  }
});

// ========== РАСПИСАНИЕ ==========
// Дайджест каждый день в 9:00 Якутск (00:00 UTC)
cron.schedule('05 1 * * *', () => {
  console.log('⏰ Автопостинг: Дайджест (9:00 Якутск)');
  dailyDigest();
});

// Идеи каждый понедельник в 10:00 Якутск (01:00 UTC)
cron.schedule('0 1 * * 1', () => {
  console.log('⏰ Автопостинг: Идеи (10:00 понедельник Якутск)');
  generateIdeas();
});

console.log('📅 Расписание активно:');
console.log('  - Дайджест: каждый день 9:00 Якутск');
console.log('  - Идеи: понедельник 10:00 Якутск');

// ========== EXPRESS ==========
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('🤖 GetCourse & Prodamus.XL Bot на Perplexity AI!');
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
  console.log(`🌐 Сервер на порту ${PORT}`);
  
  bot.setWebHook(WEBHOOK_URL)
    .then(() => {
      console.log('✅ Webhook установлен:', WEBHOOK_URL);
      console.log('🤖 Бот полностью запущен!');
    })
    .catch((err) => {
      console.error('❌ Webhook ошибка:', err.message);
    });
});
