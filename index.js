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
        model: 'llama-3.1-sonar-small-128k-chat',
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
    throw error;
  }
}

// ========== ГЛАВНАЯ ФУНКЦИЯ ДАЙДЖЕСТА ==========
async function dailyDigest() {
  console.log('📊 Создаю дайджест...');
  
  try {
    const lastDigestTime = global.lastDigestTime || 0;
    const now = Date.now();
    const hourInMs = 60 * 60 * 1000;

    if (now - lastDigestTime < hourInMs) {
      console.log('⏳ Слишком частые запросы. Подождите 1 час.');
      await bot.sendMessage(CHANNEL_ID, '⏳ Дайджест можно создавать раз в час.');
      return;
    }

    global.lastDigestTime = now;
    
    // ========== ПАРСИНГ RSS ==========
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
      await bot.sendMessage(CHANNEL_ID, '❌ Нет новых материалов за последнюю неделю.');
      return;
    }
    
    console.log(`📊 Всего спарсено: ${allArticles.length}`);
    
    // ========== ФИЛЬТРАЦИЯ ПО ВАШЕЙ ТЕМЕ ==========
    const keywords = [
      // GetCourse
      'getcourse', 'геткурс', 'гет курс', 'гк', 'get course',
      
      // Prodamus
      'prodamus', 'продамус', 'продамуса', 'xl', 'prodamus.xl',
      
      // Онлайн-школы и курсы
      'онлайн-школ', 'онлайн школ', 'онлайн-курс', 'онлайн курс',
      'edtech', 'образовательн', 'обучающ', 'курс', 'школ',
      
      // Лендинги и конструкторы
      'лендинг', 'landing', 'посадочн', 'одностраничник',
      'tilda', 'тильда', 'конструктор сайт', 'landing page', 'создать сайт',
      
      // Личный кабинет
      'личный кабинет', 'лк', 'кабинет', 'dashboard',
      'кастомизация кабинет', 'настройка кабинет', 'оформление личного кабинета',
      
      // Кастомизация и дизайн
      'кастомизац', 'кастом', 'персонализац',
      'дизайн сайт', 'ui/ux', 'интерфейс',
      'брендинг', 'оформлен',
      
      // Скрипты и разработка
      'javascript', 'js код', 'скрипт для сайт',
      'вебхук', 'webhook', 'api интеграц',
      'автоматизац', 'интеграц',
      
      // Email и рассылки
      'email', 'имейл', 'рассылк', 'письм',
      'триггер', 'автоответчик', 'цепочк писем',
      
       // Аналитика
      'аналитика онлайн', 'метрика', 'яндекс.метрика',
      'google analytics', 'конверсия', 'a/b тест',
      
      // Веб-разработка для онлайн-бизнеса
      'веб-сервис', 'saas', 'веб-приложен',
      'rest api', 'backend для курс',
      
      // Маркетинг онлайн-школ
        'продвижение онлайн', 'маркетинг edtech'
    ];
    
    const relevantArticles = allArticles.filter(article => {
      const text = (article.title + ' ' + article.snippet).toLowerCase();
      
      // Проверяем, есть ли хотя бы одно ключевое слово
      const isRelevant = keywords.some(keyword => text.includes(keyword.toLowerCase()));
      
      if (isRelevant) {
        console.log(`✅ Релевантно [${article.source}]: ${article.title.substring(0, 50)}...`);
      }
      
      return isRelevant;
    });
    
    console.log(`🎯 Релевантных материалов: ${relevantArticles.length} из ${allArticles.length}`);
    
    // Если релевантных очень мало - расширяем поиск
    if (relevantArticles.length < 5) {
      console.log('⚠️ Мало релевантных материалов, добавляю смежные темы...');
      
      const softKeywords = [
        'веб-разработка', 'frontend', 'backend', 'fullstack',
        'css', 'html', 'верстка', 'адаптив',
        'дизайн', 'ui', 'ux', 'figma',
       
      ];
      
      const additionalArticles = allArticles.filter(article => {
        if (relevantArticles.includes(article)) return false;
        
        const text = (article.title + ' ' + article.snippet).toLowerCase();
        return softKeywords.some(keyword => text.includes(keyword.toLowerCase()));
      });
      
      relevantArticles.push(...additionalArticles.slice(0, 10));
      console.log(`➕ Добавлено ${additionalArticles.slice(0, 10).length} смежных материалов`);
    }
    
    if (relevantArticles.length === 0) {
      console.log('❌ Нет материалов по вашей теме');
      await bot.sendMessage(CHANNEL_ID, 
        `❌ За последнюю неделю нет материалов по темам:\n` +
        `• GetCourse, Prodamus.XL\n` +
        `• Лендинги и онлайн-школы\n` +
        `• Кастомизация и автоматизация\n\n` +
        `Попробуйте позже!`
      );
      return;
    }
    
    // Сортировка по дате
    relevantArticles.sort((a, b) => {
      const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
      const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
      return dateB - dateA;
    });
    
    // ========== ГРУППИРОВКА ПО ИСТОЧНИКАМ ==========
    const bySource = {};
    relevantArticles.forEach(article => {
      if (!bySource[article.source]) {
        bySource[article.source] = [];
      }
      bySource[article.source].push(article);
    });
    
    // Берем ТОП-3 из каждого источника (только релевантных!)
    const selectedArticles = [];
    
    Object.keys(bySource).forEach(source => {
      const top3 = bySource[source].slice(0, 3);
      selectedArticles.push(...top3);
      console.log(`📌 ${source}: взято ${top3.length} релевантных материалов`);
    });
    
    console.log(`✅ Итого отобрано: ${selectedArticles.length} релевантных материалов`);
    
    // ========== ФОРМИРОВАНИЕ ДАЙДЖЕСТА ==========
    let digest = `📰 ДАЙДЖЕСТ: GetCourse и Prodamus.XL\n`;
    digest += `📅 ${weekAgo.toLocaleDateString('ru-RU')} - ${new Date().toLocaleDateString('ru-RU')}\n\n`;
    digest += `**Материалы по вашим темам (${selectedArticles.length}):**\n\n`;
    
    // Группируем по источникам для отображения
    const groupedForDisplay = {};
    selectedArticles.forEach(article => {
      if (!groupedForDisplay[article.source]) {
        groupedForDisplay[article.source] = [];
      }
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
    
    // ========== ОТПРАВКА В TELEGRAM ==========
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
    
    if (currentMessage) {
      messages.push(currentMessage);
    }
    
    for (const msg of messages) {
      await bot.sendMessage(CHANNEL_ID, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    }
    
    console.log('✅ Дайджест опубликован!');
    
    // ========== СОХРАНЕНИЕ В GOOGLE SHEETS ==========
    try {
      console.log(`💾 Сохраняю ${selectedArticles.length} материалов в Google Таблицы...`);
      
      for (let i = 0; i < selectedArticles.length; i++) {
        const article = selectedArticles[i];
        
        // Определяем категорию
        let category = 'Общее';
        const text = (article.title + ' ' + article.snippet).toLowerCase();
        
        if (text.includes('getcourse') || text.includes('геткурс')) {
          category = 'GetCourse';
        } else if (text.includes('prodamus') || text.includes('продамус')) {
          category = 'Prodamus';
        } else if (text.includes('landing') || text.includes('лендинг') || text.includes('tilda')) {
          category = 'Лендинги';
        } else if (text.includes('личный кабинет') || text.includes('кабинет')) {
          category = 'Личный кабинет';
        } else if (text.includes('кастом') || text.includes('дизайн')) {
          category = 'Дизайн';
        } else if (text.includes('script') || text.includes('скрипт') || text.includes('javascript')) {
          category = 'Скрипты';
        } else if (text.includes('бот') || text.includes('telegram')) {
          category = 'Боты';
        } else if (text.includes('автоматизац') || text.includes('api')) {
          category = 'Автоматизация';
        } else if (text.includes('email') || text.includes('рассылк')) {
          category = 'Email';
        } else if (text.includes('платеж') || text.includes('оплат')) {
          category = 'Платежи';
        } else if (article.type === '🎥 Видео') {
          category = 'Видео';
        } else {
          category = 'Разработка';
        }
        
        try {
          await addToSheet({
            date: article.dateFormatted,
            source: article.source,
            title: article.title,
            url: article.link,
            keywords: 'getcourse, prodamus, веб-разработка, автоматизация',
            category: category,
            analysis: article.snippet.substring(0, 200),
            idea: 'Изучить для применения'
          });
          
          console.log(`💾 ${i + 1}/${selectedArticles.length}: [${category}] ${article.title.substring(0, 40)}...`);
        } catch (sheetError) {
          console.log(`❌ Ошибка сохранения ${i + 1}: ${sheetError.message}`);
        }
      }
      
      console.log('✅ Сохранено в Google Таблицы!');
      
    } catch (error) {
      console.log(`❌ Ошибка Google Sheets: ${error.message}`);
    }
    
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    await bot.sendMessage(CHANNEL_ID, '❌ Ошибка при создании дайджеста.');
  }
}

// ========== ГЕНЕРАЦИЯ ИДЕЙ ==========
async function generateIdeas() {
  console.log('💡 Генерирую идеи...');
  
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
3. **Польза** (какой результат получит читатель)

Максимум 1200 символов. ТОЛЬКО НА РУССКОМ.`;

    const ideas = await askPerplexity(prompt);
    
    await bot.sendMessage(CHANNEL_ID, `💡 ИДЕИ КОНТЕНТА НА НЕДЕЛЮ\n\n${ideas}`, {
      parse_mode: 'Markdown'
    });
    
    console.log('✅ Идеи опубликованы!');
    
  } catch (error) {
    console.error('❌ Ошибка генерации идей:', error.message);
    await bot.sendMessage(CHANNEL_ID, '❌ Ошибка при генерации идей.');
  }
}

// ========== КОМАНДЫ БОТА ==========
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `👋 Привет! Я AI-помощник по автоматизации GetCourse и Prodamus.XL.

**Что я умею:**
✅ Собираю дайджесты (GetCourse, Prodamus, лендинги, автоматизация)
✅ Генерирую идеи контента
✅ Сохраняю материалы в базу знаний

**Команды:**
/digest - дайджест за неделю
/ideas - идеи контента
/stats - статистика базы

**Автоматически:**
📅 Каждый день в 9:00 - дайджест
💡 Каждый понедельник в 10:00 - идеи

🚀 Perplexity AI + Google Sheets`
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
      await bot.sendMessage(msg.chat.id, '❌ База пуста.');
      return;
    }
    
    const categories = {};
    allData.forEach(row => {
      const cat = row.category || 'Без категории';
      categories[cat] = (categories[cat] || 0) + 1;
    });
    
    let stats = `📊 СТАТИСТИКА БАЗЫ ЗНАНИЙ\n\n`;
    stats += `📚 Всего: ${allData.length}\n\n`;
    stats += `**По категориям:**\n`;
    
    Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        stats += `• ${cat}: ${count}\n`;
      });
    
    await bot.sendMessage(msg.chat.id, stats, { parse_mode: 'Markdown' });
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка: ' + error.message);
  }
});

// ========== РАСПИСАНИЕ ==========
// Якутск = UTC+9, значит вычитаем 9 часов

// Дайджест каждый день в 9:00 Якутск = 00:00 UTC
cron.schedule('0 0 * * *', () => {
  console.log('⏰ Дайджест (9:00 Якутск)');
  dailyDigest();
});

// Идеи каждый понедельник в 10:00 Якутск = 01:00 UTC
cron.schedule('0 1 * * 1', () => {
  console.log('⏰ Идеи (10:00 понедельник Якутск)');
  generateIdeas();
});

console.log('📅 Расписание:');
console.log('  - Дайджест: каждый день 9:00 Якутск (00:00 UTC)');
console.log('  - Идеи: понедельник 10:00 Якутск (01:00 UTC)');

// ========== EXPRESS СЕРВЕР ==========
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
      console.log('✅ Webhook:', WEBHOOK_URL);
      console.log('🤖 Бот запущен!');
    })
    .catch((err) => {
      console.error('❌ Webhook error:', err.message);
    });
});
