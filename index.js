const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser');
const cron = require('node-cron');
const express = require('express');
const { addToSheet, getFromSheet, searchInSheet } = require('./sheets');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;

const bot = new TelegramBot(TELEGRAM_TOKEN);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const parser = new Parser();

const PORT = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL 
  ? `${process.env.RENDER_EXTERNAL_URL}/webhook`
  : `https://telegram-content-bot-nvhg.onrender.com/webhook`;

console.log('🤖 Бот запущен!');

const RSS_SOURCES = {
  // Проверенные источники (100% работают)
  'VC.ru': 'https://vc.ru/rss',
  'Habr': 'https://habr.com/ru/rss/all/all/',
  'Habr Веб-разработка': 'https://habr.com/ru/rss/hub/webdev/all/',
  'Cossa': 'https://www.cossa.ru/rss/',
  
  // YouTube
  'YouTube: Владилен Минин': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCg8ss4xW9jASrqWGP30jXiw',
  'YouTube: Гоша Дударь': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvuY904el7JvBlPbdqbfguw',
  
  
}; 
async function dailyDigest() {
  console.log('📊 Создаю дайджест...');
  
  try {
    const allArticles = [];
    
    for (const [sourceName, rssUrl] of Object.entries(RSS_SOURCES)) {
      try {
        console.log(`📥 Парсинг: ${sourceName}...`);
        const feed = await parser.parseURL(rssUrl);
        
        if (!feed || !feed.items || feed.items.length === 0) {
          console.log(`⚠️ Нет материалов: ${sourceName}`);
          continue;
        }
        
        const recentArticles = feed.items.slice(0, 10).map(item => {
          const isYouTube = item.link?.includes('youtube.com');
          
          return {
            title: item.title || 'Без названия',
            link: item.link || '',
            source: sourceName,
            snippet: item.contentSnippet?.substring(0, 300) || 
                     item.content?.substring(0, 300) || 
                     item.description?.substring(0, 300) || '',
            type: isYouTube ? 'видео' : 'статья',
            pubDate: item.pubDate || item.isoDate || ''
          };
        });
        
        allArticles.push(...recentArticles);
        console.log(`✅ Добавлено ${recentArticles.length} материалов из ${sourceName}`);
        
      } catch (error) {
        console.log(`❌ Ошибка парсинга ${sourceName}: ${error.message}`);
      }
    }
    
    if (allArticles.length === 0) {
      console.log('⚠️ Нет материалов для дайджеста');
      await bot.sendMessage(CHANNEL_ID, '❌ Сегодня нет новых материалов. Попробую позже!');
      return;
    }
    
    console.log(`📊 Всего собрано материалов: ${allArticles.length}`);
    
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    
    const digestPrompt = `Ты эксперт по автоматизации онлайн-школ и веб-разработке.

Выбери ТОП-3 самых полезных материала из этого списка по темам:
- Автоматизация и оформление личного кабинета GetCourse
- Настройка и оформление личного кабинета Prodamus.XL
- Дизайн и верстка лендингов GetCourse и Prodamus.XL
- Скрипты для веб-разработки
- Маркетинг онлайн-курсов

МАТЕРИАЛЫ:
${allArticles.slice(0, 30).map((a, i) => `
${i + 1}. ${a.type === 'видео' ? '🎥 ВИДЕО' : '📄 СТАТЬЯ'} ${a.title}
Источник: ${a.source}
Ссылка: ${a.link}
Краткое содержание: ${a.snippet}
`).join('\n')}

Создай пост для Telegram (максимум 2000 символов):

📰 ДАЙДЖЕСТ: GetCourse, продажи и автоматизация

Для каждого материала:
- Эмодзи
- Название
- 2-3 предложения: главная идея и практическая ценность
- Ссылка

В конце добавь:
💡 Главный инсайт дня - один практический совет

Если ничего релевантного нет - напиши: "Сегодня мало полезного. Используйте /search для поиска"

Используй эмодзи, пиши конкретно и ПО-РУССКИ.`;

    const digestResult = await model.generateContent(digestPrompt);
    const digest = digestResult.response.text();
    
    await bot.sendMessage(CHANNEL_ID, digest, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    
    console.log('✅ Дайджест опубликован!');
    
    try {
      const topArticles = allArticles.slice(0, 3);
      
      if (topArticles.length > 0) {
        console.log('💾 Сохраняю в Google Таблицы...');
        
        for (let i = 0; i < topArticles.length; i++) {
          const article = topArticles[i];
          
          let category = 'Общее';
          const titleLower = article.title.toLowerCase();
          
          if (titleLower.includes('getcourse') || titleLower.includes('геткурс')) {
            category = 'GetCourse';
          } else if (titleLower.includes('prodamus') || titleLower.includes('продамус')) {
            category = 'Prodamus.XL';
          } else if (titleLower.includes('landing') || titleLower.includes('лендинг') || titleLower.includes('tilda') || titleLower.includes('тильда')) {
            category = 'Лендинги';
          } else if (titleLower.includes('script') || titleLower.includes('скрипт') || titleLower.includes('javascript')) {
            category = 'Скрипты';
          } else if (article.type === 'видео') {
            category = 'Видео';
          } else {
            category = 'Маркетинг';
          }
          
          await addToSheet({
            date: new Date().toLocaleDateString('ru-RU'),
            source: article.source,
            title: article.title,
            url: article.link,
            keywords: 'getcourse, автоматизация, онлайн-школа',
            category: category,
            analysis: article.snippet.substring(0, 200),
            idea: 'Изучить и применить в проекте'
          });
          
          console.log(`💾 Сохранено ${i + 1}/${topArticles.length}`);
        }
        
        console.log('✅ Данные сохранены в Google Таблицы!');
      }
      
    } catch (error) {
      console.log(`❌ Ошибка сохранения в Таблицы: ${error.message}`);
    }
    
  } catch (error) {
    console.error('❌ Ошибка в dailyDigest:', error.message);
    try {
      await bot.sendMessage(CHANNEL_ID, '❌ Ошибка при создании дайджеста. Попробую позже.');
    } catch (e) {
      console.error('❌ Не могу отправить сообщение об ошибке');
    }
  }
}

async function generateIdeas() {
  console.log('💡 Генерирую идеи...');
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    
    const prompt = `Ты стратег по контенту и эксперт по автоматизации онлайн-школ.

Темы канала:
- Автоматизация, оформление и верстка личных кабинетов и сайтов GetCourse
- Оформление и верстка личных кабинетов и сайтов Prodamus.XL
- Дизайн лендингов
- JavaScript скрипты для платформ
- Воронки продаж

Сгенерируй 5 идей для контента на следующую неделю:

Для каждой идеи:
1. Название (цепляющее, с цифрами)
2. Формат (статья/видео/чек-лист/кейс)
3. Структура контента (3-5 ключевых блоков)
4. Практическая ценность (конкретный результат)
5. Сложность (начальный/средний/продвинутый)
6. Оценка вовлечённости (1-10)

Идеи должны быть:
- Практичными с конкретными инструкциями
- Про современные инструменты 2026 года
- Решать реальные проблемы аудитории
- Направлены на автоматизацию и рост продаж

Оформи как пост для Telegram с эмодзи, НА РУССКОМ ЯЗЫКЕ.`;

    const result = await model.generateContent(prompt);
    const ideas = result.response.text();
    
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
    `👋 Привет! Я AI-помощник по автоматизации GetCourse, Prodamus и лендингов.

**Команды:**
/digest - получить дайджест сейчас
/ideas - сгенерировать 5 идей для контента
/analyze [URL] - проанализировать статью или лендинг
/search [слово] - поиск в базе знаний
/stats - статистика базы данных

**Автоматически:**
📅 Каждый день в 9:00 - дайджест по GetCourse и автоматизации
💡 Каждый понедельник в 10:00 - идеи контента на неделю
💾 Всё сохраняется в Google Таблицы для аналитики

**Темы:**
• Автоматизация GetCourse и Prodamus.XL
• Кастомизация личных кабинетов и создание лендингов
• Скрипты для онлайн-платформ`
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

bot.onText(/\/analyze (.+)/, async (msg, match) => {
  const url = match[1];
  await bot.sendMessage(msg.chat.id, '⏳ Анализирую...');
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    
    const prompt = `Проанализируй этот материал как эксперт по GetCourse и веб-разработке: ${url}

Извлеки и структурируй:

1. Основная тема и суть (2-3 предложения)
2. Ключевые технологии/инструменты
3. Практическая ценность - что можно применить в GetCourse/Prodamus
4. Сложность реализации (начальный/средний/продвинутый)
5. Идеи адаптации для вашего проекта
6. Ключевые слова для каталогизации (7-10 тегов)

Оформи как структурированный текст для Telegram с эмодзи, НА РУССКОМ ЯЗЫКЕ.`;

    const result = await model.generateContent(prompt);
    const analysis = result.response.text();
    
    const maxLength = 4000;
    if (analysis.length > maxLength) {
      const chunks = analysis.match(new RegExp(`.{1,${maxLength}}`, 'g'));
      for (const chunk of chunks) {
        await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
      }
    } else {
      await bot.sendMessage(msg.chat.id, analysis, { parse_mode: 'Markdown' });
    }
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка анализа: ' + error.message);
  }
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const keyword = match[1];
  await bot.sendMessage(msg.chat.id, `🔍 Ищу: "${keyword}"...`);
  
  try {
    const results = await searchInSheet(keyword);
    
    if (results.length === 0) {
      await bot.sendMessage(msg.chat.id, 
        `❌ Ничего не найдено по запросу "${keyword}".\n\n💡 Попробуйте: getcourse, prodamus, лендинг, скрипт`
      );
      return;
    }
    
    let response = `📊 Найдено материалов: ${results.length}\n\n`;
    
    results.slice(0, 5).forEach((row, i) => {
      response += `${i + 1}. ${row[2]}\n`;
      response += `📂 Категория: ${row[5]}\n`;
      response += `🔗 ${row[3]}\n\n`;
    });
    
    if (results.length > 5) {
      response += `...и ещё ${results.length - 5}. Уточните запрос.`;
    }
    
    await bot.sendMessage(msg.chat.id, response);
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка поиска: ' + error.message);
  }
});

bot.onText(/\/stats/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '📊 Получаю статистику...');
  
  try {
    const allData = await getFromSheet();
    
    if (allData.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ База данных пуста. Запустите /digest для сбора материалов.');
      return;
    }
    
    const categories = {};
    const sources = {};
    
    allData.forEach(row => {
      const category = row[5] || 'Без категории';
      const source = row[1] || 'Неизвестно';
      
      categories[category] = (categories[category] || 0) + 1;
      sources[source] = (sources[source] || 0) + 1;
    });
    
    let stats = `📊 СТАТИСТИКА БАЗЫ ДАННЫХ\n\n`;
    stats += `📚 Всего материалов: ${allData.length}\n\n`;
    
    stats += `📂 По категориям:\n`;
    Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        stats += `  • ${cat}: ${count}\n`;
      });
    
    stats += `\n📰 По источникам:\n`;
    Object.entries(sources)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([src, count]) => {
        stats += `  • ${src}: ${count}\n`;
      });
    
    await bot.sendMessage(msg.chat.id, stats);
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка получения статистики: ' + error.message);
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
  res.send('🤖 GetCourse бот работает! Агрегация контента активна.');
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
      console.log('📅 Расписание:');
      console.log('   - Дайджест: каждый день в 9:00');
      console.log('   - Идеи: каждый понедельник в 10:00');
      console.log('🎯 Темы: GetCourse, Prodamus, лендинги, автоматизация');
    })
    .catch((err) => {
      console.error('❌ Ошибка webhook:', err.message);
    });
});
