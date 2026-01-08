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
  'Habr Веб-разработка': 'https://habr.com/ru/rss/hub/webdev/all/',
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
            content: 'Ты эксперт по автоматизации онлайн-школ, GetCourse, Prodamus.XL, веб-разработке, лендингам и кастомизации личных кабинетов. Отвечай кратко, конкретно и только на русском языке.'
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
              snippet: item.contentSnippet?.substring(0, 300) || 
                       item.content?.substring(0, 300) || 
                       item.description?.substring(0, 300) || '',
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
    
    // ФИЛЬТРУЕМ по ключевым словам ВАШЕЙ ТЕМЫ
    const keywords = [
      'getcourse', 'геткурс', 'гет курс', 'гк',
      'prodamus', 'продамус', 'xl',
      'онлайн-школ', 'онлайн-курс', 'онлайн школ', 'курс',
      'лендинг', 'landing', 'сайт', 'веб-дизайн',
      'tilda', 'тильда', 'конструктор',
      'личный кабинет', 'лк', 'кабинет',
      'кастомизац', 'кастом', 'настройк',
      'скрипт', 'javascript', 'js', 'код',
      'автоматизац', 'авто', 'интеграц',
      'платеж', 'оплат', 'payment',
      'email', 'рассылк', 'письм',
      'воронк', 'funnel', 'продаж',
      'crm', 'amocrm', 'битрикс',
      'webhook', 'api', 'rest',
      'дизайн', 'ui', 'ux', 'interface',
      'вебинар', 'обучени', 'edtech',
      'чат-бот', 'бот', 'telegram', 'телеграм',
      'nps', 'аналитик', 'метрик',
      'a/b тест', 'конверси', 'трафик',
      'css', 'html', 'верстка', 'адаптив',
      'sms', 'уведомлен', 'триггер'
    ];
    
    const relevantArticles = allArticles.filter(article => {
      const text = (article.title + ' ' + article.snippet).toLowerCase();
      return keywords.some(keyword => text.includes(keyword));
    });
    
    console.log(`🎯 Релевантных материалов по вашей теме: ${relevantArticles.length}`);
    
    // Если релевантных мало - берем все
    const articlesToAnalyze = relevantArticles.length >= 5 ? relevantArticles : allArticles;
    
    // Используем Perplexity для создания дайджеста
    const digestPrompt = `Ты эксперт по GetCourse, Prodamus.XL, веб-разработке и автоматизации онлайн-школ.

ТВОЯ ЗАДАЧА: Из списка материалов выбери ТОП-3 САМЫХ ПОЛЕЗНЫХ для специалиста по GetCourse и Prodamus.XL.

ПРИОРИТЕТНЫЕ ТЕМЫ (в порядке важности):
1. Автоматизация GetCourse и Prodamus.XL (интеграции, API, webhooks)
2. Дизайн и кастомизация лендингов (Tilda, конструкторы)
3. Оформление и кастомизация личных кабинетов GetCourse
4. Скрипты и решения (JavaScript, CSS, HTML)
5. Платежи и настройка Prodamus.XL
6. Email-маркетинг и триггерные рассылки
7. Чат-боты и Telegram-интеграции
8. Воронки продаж и конверсии
9. Веб-разработка для онлайн-школ
10. Аналитика и метрики онлайн-курсов

МАТЕРИАЛЫ ЗА НЕДЕЛЮ:
${articlesToAnalyze.slice(0, 30).map((a, i) => `
${i + 1}. ${a.type === 'видео' ? '🎥' : '📄'} ${a.title}
📂 ${a.source}
📅 ${a.dateFormatted}
📝 ${a.snippet}
🔗 ${a.link}
`).join('\n')}

ФОРМАТ ПОСТА для Telegram (максимум 1300 символов):

📰 ДАЙДЖЕСТ: GetCourse, Prodamus.XL и автоматизация

Для каждого из ТОП-3 материалов:
- Эмодзи (подходящий по теме) + **Название**
- 1-2 предложения: КОНКРЕТНАЯ практическая польза для работы с GetCourse/Prodamus
- Ссылка

В конце:
💡 **Главный тренд недели** (1 предложение о том, что сейчас актуально)

ПРАВИЛА:
- Выбирай ТОЛЬКО материалы по темам GetCourse, Prodamus.XL, лендинги, автоматизация онлайн-школ
- Если подходящих материалов меньше 3 - напиши сколько есть
- Если НЕТ подходящих материалов - напиши "Нет релевантных материалов на этой неделе"
- Пиши ТОЛЬКО НА РУССКОМ ЯЗЫКЕ
- Будь конкретен и практичен`;

    const digest = await askPerplexity(digestPrompt);
    
    // Проверяем, нашлись ли релевантные материалы
    if (digest.toLowerCase().includes('нет релевантных')) {
      console.log('⚠️ Perplexity не нашел релевантных материалов');
      
      // Отправляем упрощенный дайджест с фильтрацией
      let simpleDigest = `📰 ДАЙДЖЕСТ: GetCourse и Prodamus.XL\n`;
      simpleDigest += `🗓️ ${weekAgo.toLocaleDateString('ru-RU')} - ${new Date().toLocaleDateString('ru-RU')}\n\n`;
      
      if (relevantArticles.length > 0) {
        simpleDigest += `**Материалы по вашей теме:**\n\n`;
        relevantArticles.slice(0, 8).forEach((a, i) => {
          simpleDigest += `${i + 1}. ${a.type === 'видео' ? '🎥' : '📄'} ${a.title}\n`;
          simpleDigest += `📅 ${a.dateFormatted} | 📂 ${a.source}\n`;
          simpleDigest += `🔗 ${a.link}\n\n`;
        });
      } else {
        simpleDigest += `❌ На этой неделе нет новых материалов по GetCourse/Prodamus.\n\n`;
        simpleDigest += `**Общие материалы по веб-разработке:**\n\n`;
        allArticles.slice(0, 5).forEach((a, i) => {
          simpleDigest += `${i + 1}. ${a.title}\n`;
          simpleDigest += `📂 ${a.source} | 🔗 ${a.link}\n\n`;
        });
      }
      
      await bot.sendMessage(CHANNEL_ID, simpleDigest, {
        disable_web_page_preview: true
      });
    } else {
      // Отправляем дайджест от Perplexity
      const finalDigest = `🗓️ ${weekAgo.toLocaleDateString('ru-RU')} - ${new Date().toLocaleDateString('ru-RU')}\n\n${digest}`;
      
      await bot.sendMessage(CHANNEL_ID, finalDigest, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      });
    }
    
    console.log('✅ Дайджест опубликован!');
    
    // СОХРАНЕНИЕ В GOOGLE ТАБЛИЦЫ
    try {
      const topArticles = relevantArticles.slice(0, 5);
      
      if (topArticles.length > 0) {
        console.log('💾 Сохраняю в Google Таблицы...');
        
        for (let i = 0; i < topArticles.length; i++) {
          const article = topArticles[i];
          
          // Определяем категорию
          let category = 'Общее';
          const titleLower = article.title.toLowerCase();
          const snippetLower = article.snippet.toLowerCase();
          const text = titleLower + ' ' + snippetLower;
          
          if (text.includes('getcourse') || text.includes('геткурс')) {
            category = 'GetCourse';
          } else if (text.includes('prodamus') || text.includes('продамус')) {
            category = 'Prodamus';
          } else if (text.includes('landing') || text.includes('лендинг') || text.includes('tilda') || text.includes('тильда')) {
            category = 'Лендинги';
          } else if (text.includes('личный кабинет') || text.includes('кабинет') || text.includes('лк')) {
            category = 'Личный кабинет';
          } else if (text.includes('кастом') || text.includes('настройк') || text.includes('дизайн')) {
            category = 'Кастомизация';
          } else if (text.includes('script') || text.includes('скрипт') || text.includes('javascript') || text.includes('код')) {
            category = 'Скрипты';
          } else if (text.includes('бот') || text.includes('telegram') || text.includes('телеграм')) {
            category = 'Боты';
          } else if (text.includes('автоматизац') || text.includes('интеграц') || text.includes('api') || text.includes('webhook')) {
            category = 'Автоматизация';
          } else if (text.includes('платеж') || text.includes('оплат')) {
            category = 'Платежи';
          } else if (text.includes('email') || text.includes('рассылк')) {
            category = 'Email-маркетинг';
          } else if (article.type === 'видео') {
            category = 'Видео';
          } else {
            category = 'Разработка';
          }
          
          await addToSheet({
            date: article.dateFormatted,
            source: article.source,
            title: article.title,
            url: article.link,
            keywords: 'getcourse, prodamus, автоматизация, лендинги, кастомизация',
            category: category,
            analysis: article.snippet.substring(0, 200),
            idea: 'Изучить и применить в проекте'
          });
          
          console.log(`💾 Сохранено ${i + 1}/${topArticles.length}: [${category}] ${article.title.substring(0, 40)}...`);
        }
        
        console.log('✅ Данные сохранены в Google Таблицы!');
      } else {
        console.log('⚠️ Нет релевантных материалов для сохранения');
      }
      
    } catch (error) {
      console.log(`❌ Ошибка сохранения в Таблицы: ${error.message}`);
    }
    
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
      
      let simpleDigest = `📰 ДАЙДЖЕСТ за неделю (упрощенный)\n\n`;
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
    const prompt = `Ты стратег контента для эксперта по GetCourse и Prodamus.XL.

Сгенерируй 5 КОНКРЕТНЫХ идей для постов/видео на следующую неделю по темам:

1. Автоматизация GetCourse и Prodamus.XL (скрипты, интеграции, webhooks)
2. Дизайн и кастомизация лендингов (Tilda, конструкторы)
3. Оформление личных кабинетов GetCourse (UI/UX, кастомизация)
4. JavaScript скрипты и решения для онлайн-школ
5. Платежные системы и Prodamus.XL настройки
6. Email-маркетинг и триггерные цепочки
7. Telegram-боты для онлайн-школ
8. Воронки продаж и конверсия

Для каждой идеи укажи:
1. **Название** (цепляющее, с цифрами или конкретикой)
2. **Формат** (пост/видео/кейс/чек-лист/инструкция)
3. **Практическая ценность** (что получит читатель, конкретный результат)
4. **Сложность** (Легко/Средне/Сложно)

Оформи как пост для Telegram с эмодзи, НА РУССКОМ ЯЗЫКЕ, максимум 1500 символов.

Делай упор на ПРАКТИЧЕСКИЕ решения и кейсы.`;

    const ideas = await askPerplexity(prompt);
    
    await bot.sendMessage(CHANNEL_ID, `💡 ИДЕИ КОНТЕНТА НА НЕДЕЛЮ\n\n${ideas}`, {
      parse_mode: 'Markdown'
    });
    
    console.log('✅ Идеи опубликованы!');
    
  } catch (error) {
    console.error('❌ Ошибка в generateIdeas:', error.message);
    await bot.sendMessage(CHANNEL_ID, '❌ Ошибка при генерации идей.');
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `👋 Привет! Я AI-помощник по автоматизации GetCourse и Prodamus.XL.

**Что я умею:**
✅ Собираю дайджесты по GetCourse, Prodamus, лендингам, автоматизации
✅ Генерирую идеи контента для постов и видео
✅ Сохраняю полезные материалы в базу знаний

**Команды:**
/digest - дайджест за неделю (GetCourse, Prodamus, кастомизация, скрипты)
/ideas - идеи контента на неделю
/stats - статистика базы знаний

**Автоматически:**
📅 Каждый день в 9:00 - дайджест
💡 Каждый понедельник в 10:00 - идеи контента

🚀 Работаю на Perplexity AI`
  );
});

bot.onText(/\/digest/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Создаю дайджест по GetCourse и Prodamus...');
  await dailyDigest();
  await bot.sendMessage(msg.chat.id, '✅ Готово! Проверьте канал.');
});

bot.onText(/\/ideas/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Генерирую идеи контента...');
  await generateIdeas();
  await bot.sendMessage(msg.chat.id, '✅ Готово! Проверьте канал.');
});

bot.onText(/\/stats/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '📊 Получаю статистику базы знаний...');
  
  try {
    const allData = await getFromSheet();
    
    if (allData.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ База данных пуста.');
      return;
    }
    
    // Подсчет по категориям
    const categories = {};
    allData.forEach(row => {
      const cat = row.category || 'Без категории';
      categories[cat] = (categories[cat] || 0) + 1;
    });
    
    let stats = `📊 СТАТИСТИКА БАЗЫ ЗНАНИЙ\n\n`;
    stats += `📚 Всего материалов: ${allData.length}\n\n`;
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

// Расписание: каждый день в 9:00 (время Якутска)
cron.schedule('0 9 * * *', () => {
  console.log('⏰ Запуск ежедневного дайджеста...');
  dailyDigest();
}, {
  timezone: "Asia/Yakutsk"
});

// Расписание: каждый понедельник в 10:00
cron.schedule('0 10 * * 1', () => {
  console.log('⏰ Генерирую идеи контента на неделю...');
  generateIdeas();
}, {
  timezone: "Asia/Yakutsk"
});

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('🤖 GetCourse & Prodamus.XL Content Bot работает на Perplexity AI!');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    theme: 'GetCourse, Prodamus.XL, автоматизация, лендинги, кастомизация'
  });
});

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  console.log('📋 Темы: GetCourse, Prodamus, кредитование, автоматизация');
  
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
