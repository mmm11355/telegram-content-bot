const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser');
const cron = require('node-cron');
const express = require('express');
const { addToSheet, getFromSheet, searchInSheet } = require('./sheets');

// Получаем переменные окружения
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;

// Инициализация
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const parser = new Parser();

console.log('✅ Бот запущен! Ожидаю команды...');

// RSS источники для вашей ниши
const RSS_SOURCES = {
  'VC Право': 'https://vc.ru/legal/rss',
  'VC Образование': 'https://vc.ru/education/rss',
  'Habr Образование': 'https://habr.com/ru/rss/hub/education/all/'
};

// ФУНКЦИЯ 1: Ежедневный контент-агрегатор с сохранением в Google Sheets
async function dailyDigest() {
  console.log('📰 Собираю дайджест...');
  
  try {
    const allArticles = [];
    
    // Парсим RSS
    for (const [sourceName, rssUrl] of Object.entries(RSS_SOURCES)) {
      try {
        const feed = await parser.parseURL(rssUrl);
        const recentArticles = feed.items.slice(0, 5).map(item => ({
          title: item.title,
          link: item.link,
          source: sourceName,
          snippet: item.contentSnippet?.substring(0, 200) || ''
        }));
        
        allArticles.push(...recentArticles);
      } catch (error) {
        console.log(`⚠️ Ошибка парсинга ${sourceName}:`, error.message);
      }
    }
    
    if (allArticles.length === 0) {
      console.log('⚠️ Нет статей для дайджеста');
      return;
    }
    
    // Создаём дайджест через Gemini
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const digestPrompt = `Ты — эксперт по онлайн-образованию и услугам по созданию лендингов, сайтов, оформлению и верстке личных кабинетов GetCourse, Prodamus.XL для бизнеса.

Проанализируй эти статьи и создай краткий дайджест для Telegram-канала:

${allArticles.map((a, i) => `
${i + 1}. ${a.title}
Источник: ${a.source}
Ссылка: ${a.link}
Краткое содержание: ${a.snippet}
`).join('\n')}

Создай пост для Telegram (до 1500 символов):

📊 **ДАЙДЖЕСТ ДНЯ: EdTech. Верстка, оформление и настройка GetCourse, Prodamus.XL**

Выбери ТОП-3 самых важных статьи для владельцев онлайн-школ.

Для каждой статьи:
- Заголовок с эмодзи
- 2-3 предложения: суть и практическая польза
- Ссылка

В конце добавь раздел "💡 Главный инсайт дня" — один практический вывод.

Используй эмодзи, структурируй текст, пиши живо и конкретно.`;

    const digestResult = await model.generateContent(digestPrompt);
    const digest = digestResult.response.text();
    
    // Отправляем в канал
    await bot.sendMessage(CHANNEL_ID, digest, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    
    console.log('✅ Дайджест опубликован!');
    
    // Сохраняем в Google Sheets
    for (const article of allArticles.slice(0, 3)) {
      const analysisPrompt = `Проанализируй статью кратко:
Заголовок: ${article.title}
Содержание: ${article.snippet}

Верни ТОЛЬКО JSON без дополнительного текста:
{
  "keywords": "5-7 ключевых слов через запятую",
  "category": "одна категория: EdTech/Автоматизация/Маркетинг",
  "analysis": "краткое резюме в 1-2 предложениях",
  "idea": "как можно использовать эту тему для создания своего контента"
}`;

      const analysisResult = await model.generateContent(analysisPrompt);
      let analysisData;
      
      try {
        const jsonText = analysisResult.response.text()
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        analysisData = JSON.parse(jsonText);
      } catch (e) {
        analysisData = {
          keywords: '',
          category: '',
          analysis: analysisResult.response.text().substring(0, 200),
          idea: ''
        };
      }
      
      // Сохраняем в таблицу
      await addToSheet({
        date: new Date().toLocaleDateString('ru-RU'),
        source: article.source,
        title: article.title,
        url: article.link,
        keywords: analysisData.keywords,
        category: analysisData.category,
        analysis: analysisData.analysis,
        idea: analysisData.idea
      });
      
      // Пауза между запросами к Gemini
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('✅ Данные сохранены в Google Sheets!');
    
  } catch (error) {
    console.error('❌ Ошибка в dailyDigest:', error.message);
  }
}

// ФУНКЦИЯ 2: Генератор идей
async function generateIdeas() {
  console.log('💡 Генерирую идеи контента...');
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `Ты — контент-стратег для онлайн-школ.

Тематика канала:
- Создание продающих сайтов, лендингов под мероприятия
- Оформление и верстка личных кабинетов GetCourse, Prodamus.XL
- Автоматизация онлайн-школ (GetCourse, Prodamus.XL)
- Образовательные проекты и EdTech
- Маркетинг для образовательных услуг

Сгенерируй 5 идей для контента на следующую неделю:

Для каждой идеи укажи:
1. **Заголовок** (цепляющий, с цифрами или вопросом)
2. **Формат** (статья 800 слов / карточки / чек-лист / видео-скрипт / кейс)
3. **Ключевые тезисы** (3-4 пункта)
4. **Целевая аудитория** (кому будет полезно)
5. **Ожидаемая реакция** (какую проблему решает)

Идеи должны быть практичными, актуальными и решать реальные задачи аудитории.`;

    const result = await model.generateContent(prompt);
    const ideas = result.response.text();
    
    await bot.sendMessage(CHANNEL_ID, 
      `📝 **ИДЕИ КОНТЕНТА НА НЕДЕЛЮ**\n\n${ideas}`,
      { parse_mode: 'Markdown' }
    );
    
    console.log('✅ Идеи опубликованы!');
    
  } catch (error) {
    console.error('❌ Ошибка в generateIdeas:', error.message);
  }
}

// КОМАНДЫ БОТА

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `Привет! Я AI-помощник для контента по онлайн-образованию.

Команды:
/digest - получить дайджест статей сейчас
/ideas - сгенерировать идеи для контента
/analyze [URL] - проанализировать статью конкурента
/search [слово] - поиск в базе знаний
/stats - статистика базы

Автоматически:
- Каждый день в 9:00 публикую дайджест
- Каждый понедельник в 10:00 генерирую идеи на неделю
- Все данные сохраняются в Google Таблицу`
  );
});

bot.onText(/\/digest/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Собираю дайджест...');
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
  await bot.sendMessage(msg.chat.id, '🔍 Анализирую статью...');
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `Проанализируй эту статью как SEO-эксперт: ${url}

Извлеки:
1. **Ключевые слова** (10-15 главных)
2. **Структура** (заголовки)
3. **Оффер** (какое предложение)
4. **Целевая аудитория**
5. **Call-to-Action**
6. **Идеи для улучшения**

Структурируй для Telegram.`;

    const result = await model.generateContent(prompt);
    await bot.sendMessage(msg.chat.id, result.response.text(), { parse_mode: 'Markdown' });
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка: ' + error.message);
  }
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const keyword = match[1];
  await bot.sendMessage(msg.chat.id, `🔍 Ищу: "${keyword}"...`);
  
  try {
    const results = await searchInSheet(keyword);
    
    if (results.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ Ничего не найдено.');
      return;
    }
    
    let response = `📚 **Найдено: ${results.length}**\n\n`;
    
    results.slice(0, 5).forEach((row, i) => {
      response += `${i + 1}. **${row[2]}**\n`;
      response += `🔗 ${row[3]}\n`;
      response += `📌 ${row[4]}\n\n`;
    });
    
    await bot.sendMessage(msg.chat.id, response, { parse_mode: 'Markdown' });
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка: ' + error.message);
  }
});

bot.onText(/\/stats/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '📊 Собираю статистику...');
  
  try {
    const allData = await getFromSheet();
    
    const categories = {};
    allData.forEach(row => {
      const category = row[5] || 'Без категории';
      categories[category] = (categories[category] || 0) + 1;
    });
    
    let stats = `📊 **СТАТИСТИКА**\n\n`;
    stats += `📚 Всего статей: ${allData.length}\n\n`;
    stats += `**По категориям:**\n`;
    
    Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        stats += `  • ${cat}: ${count}\n`;
      });
    
    await bot.sendMessage(msg.chat.id, stats, { parse_mode: 'Markdown' });
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка: ' + error.message);
  }
});

// РАСПИСАНИЕ
cron.schedule('0 9 * * *', () => {
  console.log('⏰ Время для дайджеста!');
  dailyDigest();
}, {
  timezone: "Asia/Yakutsk"
});

cron.schedule('0 10 * * 1', () => {
  console.log('⏰ Генерирую идеи!');
  generateIdeas();
}, {
  timezone: "Asia/Yakutsk"
});

// Простой веб-сервер для Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Бот работает! 🤖');
});

app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
});

console.log('🤖 Бот полностью запущен!');
