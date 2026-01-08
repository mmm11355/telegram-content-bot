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

// RSS источники
const RSS_SOURCES = {
  // Общие бизнес-ленты
  'VC.ru': 'https://vc.ru/rss',
  'Habr': 'https://habr.com/ru/rss/all/all/',
  'РБК Технологии': 'https://rssexport.rbc.ru/rbcnews/news/20/full.rss',


  // TenChat хэштеги
  'TenChat #GetCourse': 'https://tenchat.ru/media/hashtag/getcourse/rss',
  'TenChat #онлайн-школа': 'https://tenchat.ru/media/hashtag/онлайн-школа/rss',
  'TenChat #лендинг': 'https://tenchat.ru/media/hashtag/лендинг/rss',
  'TenChat #автоматизация': 'https://tenchat.ru/media/hashtag/автоматизация/rss',
  'TenChat #маркетинг': 'https://tenchat.ru/media/hashtag/маркетинг/rss',

  // YouTube поиск через RSSHub
  'YouTube: GetCourse': 'https://rsshub.app/youtube/search/getcourse',
  'YouTube: Prodamus': 'https://rsshub.app/youtube/search/prodamus.xl',
  'YouTube: Лендинги': 'https://rsshub.app/youtube/search/создание+лендингов',
  'YouTube: Автоматизация': 'https://rsshub.app/youtube/search/автоматизация+онлайн+школы',
  'YouTube: Кастомизация': 'https://rsshub.app/youtube/search/кастомизация+getcourse',
  'YouTube: Оформление': 'https://rsshub.app/youtube/search/оформление+getcourse',
  'YouTube: Prodamus.XL': 'https://rsshub.app/youtube/search/оформление+prodamus.xl',
  
  // YouTube каналы по вашей тематике (добавьте свои)
  // Формат: 'Название': 'https://www.youtube.com/feeds/videos.xml?channel_id=ID_КАНАЛА'
};

// ФУНКЦИЯ 1: Ежедневный контент-агрегатор (ОПТИМИЗИРОВАННАЯ)
async function dailyDigest() {
  console.log('📰 Собираю дайджест...');
  
  try {
    const allArticles = [];
    
    // Парсим RSS
    for (const [sourceName, rssUrl] of Object.entries(RSS_SOURCES)) {
      try {
        console.log(`Парсинг: ${sourceName}...`);
        const feed = await parser.parseURL(rssUrl);
        
        if (!feed || !feed.items || feed.items.length === 0) {
          console.log(`⚠️ ${sourceName}: нет элементов в ленте`);
          continue;
        }
        
        // Берём больше статей для фильтрации
        const recentArticles = feed.items.slice(0, 10).map(item => {
          const isYouTube = item.link?.includes('youtube.com');
          
          return {
            title: item.title || 'Без названия',
            link: item.link || '',
            source: sourceName,
            snippet: item.contentSnippet?.substring(0, 300) || 
                     item.content?.substring(0, 300) || 
                     item.description?.substring(0, 300) || '',
            type: isYouTube ? 'video' : 'article',
            author: item.author || '',
            pubDate: item.pubDate || item.isoDate || ''
          };
        });
        
        allArticles.push(...recentArticles);
        console.log(`✅ ${sourceName}: добавлено ${recentArticles.length} материалов`);
        
      } catch (error) {
        console.log(`⚠️ Ошибка парсинга ${sourceName}:`, error.message);
      }
    }
    
    if (allArticles.length === 0) {
      console.log('⚠️ Нет статей для дайджеста');
      await bot.sendMessage(CHANNEL_ID, 
        '⚠️ Сегодня не удалось собрать материалы. Попробую позже!'
      );
      return;
    }
    
    console.log(`📊 Всего собрано материалов: ${allArticles.length}`);
    
    // Создаём дайджест через Gemini (ТОЛЬКО ОДИН ЗАПРОС)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const digestPrompt = `Ты — эксперт по автоматизации онлайн-образования, веб-разработке GetCourse и Prodamus.XL.

Из этого списка материалов выбери ТОЛЬКО те, которые релевантны для следующих тем:
- Автоматизация GetCourse (интеграции, настройка, кастомизация, оформление)
- Prodamus.XL (настройка, интеграция, кастомизация, оформление)
- Оформление и кастомизация личных кабинетов
- Создание продающих сайтов и лендингов
- Скрипты и программирование для онлайн-платформ
- Веб-разработка, JavaScript, CSS, HTML
- Конструкторы сайтов, Tilda, WordPress
- Маркетинг и продажи онлайн-курсов
- CRM и автоматизация воронок

СПИСОК МАТЕРИАЛОВ:
${allArticles.slice(0, 30).map((a, i) => `
${i + 1}. ${a.type === 'video' ? '🎥' : '📄'} ${a.title}
Источник: ${a.source}
Ссылка: ${a.link}
Краткое содержание: ${a.snippet}
`).join('\n')}

ЗАДАЧА:
1. Выбери ТОП-3 САМЫХ РЕЛЕВАНТНЫХ материала по указанным темам
2. ИГНОРИРУЙ материалы про политику, спорт, развлечения, общие новости

3. Создай пост для Telegram (до 2000 символов):

📊 **ДАЙДЖЕСТ ДНЯ: GetCourse, Prodamus.XL, Продажи и Автоматизация**

Для каждого материала:
- Эмодзи (📄 для статьи, 🎥 для видео)
- Заголовок с эмодзи по теме
- 2-3 предложения: суть и практическая польза для владельца онлайн-школы или веб-разработчика
- Как можно применить в GetCourse/Prodamus
- Ссылка

В конце добавь:
💡 **Главный инсайт дня** — один практический совет по автоматизации или кастомизации

Если НИЧЕГО релевантного нет — напиши: "Сегодня нет подходящих материалов по нашей тематике. Ищите идеи в базе знаний командой /search"

Используй эмодзи, структурируй текст, пиши конкретно для практиков.`;

    const digestResult = await model.generateContent(digestPrompt);
    const digest = digestResult.response.text();
    
    // Отправляем в канал
    await bot.sendMessage(CHANNEL_ID, digest, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    
    console.log('✅ Дайджест опубликован!');
    
    // Сохраняем ТОП-3 в Google Sheets БЕЗ дополнительного AI-анализа (экономим запросы)
    try {
      const topArticles = allArticles.slice(0, 3);
      
      if (topArticles.length > 0) {
        console.log('💾 Сохраняю в Google Sheets...');
        
        for (let i = 0; i < topArticles.length; i++) {
          const article = topArticles[i];
          
          // Определяем категорию простой логикой (без AI)
          let category = 'Общее';
          const titleLower = article.title.toLowerCase();
          const snippetLower = article.snippet.toLowerCase();
          
          if (titleLower.includes('getcourse') || snippetLower.includes('getcourse')) {
            category = 'GetCourse';
          } else if (titleLower.includes('prodamus') || snippetLower.includes('prodamus')) {
            category = 'Prodamus';
          } else if (titleLower.includes('лендинг') || titleLower.includes('сайт')) {
            category = 'Лендинги';
          } else if (titleLower.includes('скрипт') || titleLower.includes('javascript')) {
            category = 'Скрипты';
          } else if (titleLower.includes('дизайн') || titleLower.includes('кастомизация')) {
            category = 'Кастомизация';
          } else if (article.type === 'video') {
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
            idea: 'Изучить и применить в своём проекте'
          });
          
          console.log(`✅ Сохранено ${i + 1}/${topArticles.length}: ${article.title.substring(0, 40)}...`);
        }
        
        console.log('✅ Все данные сохранены в Google Sheets!');
      }
      
    } catch (error) {
      console.log(`⚠️ Ошибка сохранения в Sheets (не критично): ${error.message}`);
    }
    
  } catch (error) {
    console.error('❌ Ошибка в dailyDigest:', error.message);
    try {
      await bot.sendMessage(CHANNEL_ID, 
        `❌ Ошибка при создании дайджеста. Попробую позже.`
      );
    } catch (e) {
      console.error('❌ Не удалось отправить сообщение об ошибке');
    }
  }
}

// ФУНКЦИЯ 2: Генератор идей
async function generateIdeas() {
  console.log('💡 Генерирую идеи контента...');
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `Ты — контент-стратег и эксперт по автоматизации онлайн-школ.

Тематика канала:
- Автоматизация GetCourse (интеграции, скрипты, кастомизация)
- Prodamus.XL (настройка, скрипты, интеграции)
- Оформление личных кабинетов (дизайн, UX/UI)
- Создание продающих сайтов и лендингов
- JavaScript, CSS, HTML скрипты для GetCourse, Prodamus.XL
- Конструкторы: Tilda, WordPress, Figma
- Воронки продаж и автоматизация
- Увеличение конверсии онлайн-школ

Целевая аудитория:
- Владельцы онлайн-школ на GetCourse
- Веб-разработчики, работающие с образовательными платформами
- Маркетологи и продюсеры курсов

Сгенерируй 5 идей для контента на следующую неделю:

Для каждой идеи укажи:

**1. Заголовок** (цепляющий, с цифрами или вопросом)
   Примеры: "7 скриптов для GetCourse, которые увеличат продажи на 30%"
           "Как кастомизировать личный кабинет Prodamus.XL без программиста"

**2. Формат** (статья 1000 слов / видео-туториал / чек-лист / кейс / подборка скриптов)

**3. Структура контента** (3-5 ключевых блоков)

**4. Практическая польза** (конкретный результат для читателя)

**5. Сложность реализации** (новичок/средний/продвинутый)

**6. Оценка вовлечённости** (1-10, насколько "зайдёт" у аудитории)

Идеи должны быть:
- Практичными (с конкретными инструкциями)
- Актуальными (про современные инструменты 2026)
- Решающими реальные боли аудитории
- С упором на автоматизацию и увеличение продаж

Оформи как готовый пост для Telegram с эмодзи.`;

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
    `👋 Привет! Я AI-помощник по автоматизации GetCourse, Prodamus.XL и созданию продающих сайтов.

**Команды:**
/digest - получить дайджест материалов сейчас
/ideas - сгенерировать 5 идей для контента
/analyze [URL] - проанализировать статью или лендинг
/search [слово] - поиск в базе знаний (например: /search getcourse)
/stats - статистика базы материалов

**Автоматически:**
🤖 Каждый день в 9:00 - дайджест по GetCourse, Prodamus.XL и автоматизации
🤖 Каждый понедельник в 10:00 - идеи контента на неделю
📊 Всё сохраняется в Google Таблицу для аналитики

**Тематика:**
• Автоматизация GetCourse и Prodamus.XL
• Кастомизация личных кабинетов
• Создание лендингов и продающих сайтов
• Скрипты для онлайн-платформ`
  );
});

bot.onText(/\/digest/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Собираю дайджест по GetCourse, Prodamus.XL и автоматизации...');
  await dailyDigest();
  await bot.sendMessage(msg.chat.id, '✅ Готово! Проверьте канал.');
});

bot.onText(/\/ideas/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Генерирую идеи контента...');
  await generateIdeas();
  await bot.sendMessage(msg.chat.id, '✅ Готово! Проверьте канал.');
});

bot.onText(/\/analyze (.+)/, async (msg, match) => {
  const url = match[1];
  await bot.sendMessage(msg.chat.id, '🔍 Анализирую материал...');
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `Проанализируй этот материал как эксперт по GetCourse и веб-разработке: ${url}

Извлеки и структурируй:

**1. Основная тема и суть**
- О чём материал в 2-3 предложениях

**2. Ключевые технологии/инструменты**
- Какие платформы, скрипты, инструменты упоминаются

**3. Практическая ценность**
- Что конкретно можно применить в GetCourse/Prodamus
- Какую проблему решает

**4. Сложность реализации**
- Для новичка/среднего/продвинутого уровня

**5. Идеи для адаптации**
- Как использовать эти знания в своём проекте
- Что можно улучшить или доработать

**6. Ключевые слова для поиска**
- 7-10 тегов для каталогизации

Формат ответа: структурированный текст для Telegram с эмодзи.`;

    const result = await model.generateContent(prompt);
    const analysis = result.response.text();
    
    // Разбиваем длинный ответ на части
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
  await bot.sendMessage(msg.chat.id, `🔍 Ищу в базе знаний: "${keyword}"...`);
  
  try {
    const results = await searchInSheet(keyword);
    
    if (results.length === 0) {
      await bot.sendMessage(msg.chat.id, 
        `❌ Ничего не найдено по запросу "${keyword}".\n\nПопробуйте другие ключевые слова: getcourse, prodamus, лендинг, скрипт, кастомизация`
      );
      return;
    }
    
    let response = `📚 **Найдено материалов: ${results.length}**\n\n`;
    
    results.slice(0, 5).forEach((row, i) => {
      response += `**${i + 1}. ${row[2]}**\n`;
      response += `📌 Категория: ${row[5]}\n`;
      response += `🔗 ${row[3]}\n`;
      response += `💡 ${row[7]}\n\n`;
    });
    
    if (results.length > 5) {
      response += `_...и ещё ${results.length - 5} материалов. Уточните запрос для более точного поиска._`;
    }
    
    await bot.sendMessage(msg.chat.id, response, { parse_mode: 'Markdown' });
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка поиска: ' + error.message);
  }
});

bot.onText(/\/stats/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '📊 Собираю статистику базы знаний...');
  
  try {
    const allData = await getFromSheet();
    
    if (allData.length === 0) {
      await bot.sendMessage(msg.chat.id, '📭 База знаний пока пуста. Запустите /digest для сбора материалов.');
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
    
    let stats = `📊 **СТАТИСТИКА БАЗЫ ЗНАНИЙ**\n\n`;
    stats += `📚 Всего материалов: ${allData.length}\n\n`;
    
    stats += `**По категориям:**\n`;
    Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        stats += `  • ${cat}: ${count}\n`;
      });
    
    stats += `\n**По источникам:**\n`;
    Object.entries(sources)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([src, count]) => {
        stats += `  • ${src}: ${count}\n`;
      });
    
    await bot.sendMessage(msg.chat.id, stats, { parse_mode: 'Markdown' });
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка получения статистики: ' + error.message);
  }
});

// Обработка ошибок polling
bot.on('polling_error', (error) => {
  console.log('⚠️ Polling error:', error.message);
});

// РАСПИСАНИЕ (CRON)
cron.schedule('0 9 * * *', () => {
  console.log('⏰ Время для дайджеста!');
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

// Веб-сервер для Render
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('🤖 Бот GetCourse работает! Автоматизация и контент-агрегация активны.');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
});

console.log('🤖 Бот полностью запущен!');
console.log('📅 Расписание:');
console.log('   - Дайджест: каждый день в 9:00');
console.log('   - Идеи: каждый понедельник в 10:00');
console.log('🎯 Тематика: GetCourse, Prodamus.XL, лендинги, автоматизация');
console.log('⚡ Оптимизация: 1 запрос к Gemini на дайджест (вместо 4)');
