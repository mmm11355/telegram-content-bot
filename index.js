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

console.log('Bot started!');

const RSS_SOURCES = {
  'VC.ru': 'https://vc.ru/rss',
  'Habr': 'https://habr.com/ru/rss/all/all/',
  
  'TG: GetCourse News': 'https://rsshub.app/telegram/channel/getcourse_official',
  'TG: Prodamus Updates': 'https://rsshub.app/telegram/channel/prodamus_news',

  // GetCourse конкуренты и эксперты
  'GetCourse Blog': 'https://getcourse.ru/blog/rss',
  'TG: GetCourse Official': 'https://rsshub.app/telegram/channel/getcourse_official',
  'TG: GetCourse Pro': 'https://rsshub.app/telegram/channel/GetCourseProfi',
  'TG: GetCourse Expert': 'https://rsshub.app/telegram/channel/GetCourseExpert',
  'YouTube: GetCourse Media': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCnQC5B3vy-qoGJPzvUC-SLQ',
  
  // Tilda конкуренты
  'TG: Tilda News': 'https://rsshub.app/telegram/channel/tildanews',
  'TG: Тильдошная': 'https://rsshub.app/telegram/channel/tildoshnaya',
  'YouTube: Давид Аветисян Tilda': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCwyqwByf942JzkTBYJWJKWQ',
  
  // Фриланс (проекты конкурентов)
  'TG: FreelanceBay': 'https://rsshub.app/telegram/channel/FreelanceBay',
  
  // Маркетинг
  'Cossa': 'https://www.cossa.ru/rss/',
  
  'YouTube: GetCourse Official': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCnQC5B3vy-qoGJPzvUC-SLQ',
  'YouTube: WebDev с нуля': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCP-xJwnvKCGyS-nbyOx1Wmg',
  'YouTube: Владилен Минин': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCg8ss4xW9jASrqWGP30jXiw',
  'YouTube: Гоша Дударь': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvuY904el7JvBlPbdqbfguw',
  'YouTube: WebForMyself': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCGuhp4lpQvK94ZC5kuOZbjA',
  'YouTube: Давид Аветисян': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCwyqwByf942JzkTBYJWJKWQ',
  'YouTube: LEADTEX': 'https://www.youtube.com/feeds/videos.xml?channel_id=UC9_DBtLvJ9t8bQYQSYOIo-A',
};

async function dailyDigest() {
  console.log('Creating digest...');
  
  try {
    const allArticles = [];
    
    for (const [sourceName, rssUrl] of Object.entries(RSS_SOURCES)) {
      try {
        console.log(`Parsing: ${sourceName}...`);
        const feed = await parser.parseURL(rssUrl);
        
        if (!feed || !feed.items || feed.items.length === 0) {
          console.log(`No items: ${sourceName}`);
          continue;
        }
        
        const recentArticles = feed.items.slice(0, 10).map(item => {
          const isYouTube = item.link?.includes('youtube.com');
          
          return {
            title: item.title || 'No title',
            link: item.link || '',
            source: sourceName,
            snippet: item.contentSnippet?.substring(0, 300) || 
                     item.content?.substring(0, 300) || 
                     item.description?.substring(0, 300) || '',
            type: isYouTube ? 'video' : 'article',
            pubDate: item.pubDate || item.isoDate || ''
          };
        });
        
        allArticles.push(...recentArticles);
        console.log(`Added ${recentArticles.length} items from ${sourceName}`);
        
      } catch (error) {
        console.log(`Error parsing ${sourceName}:`, error.message);
      }
    }
    
    if (allArticles.length === 0) {
      console.log('No articles for digest');
      await bot.sendMessage(CHANNEL_ID, 'No materials today. Try again later!');
      return;
    }
    
    console.log(`Total articles: ${allArticles.length}`);
    
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const digestPrompt = `You are an expert in online education automation and web development.

Select TOP-3 MOST RELEVANT materials from this list about:
- GetCourse automation, кастомизация, оформление, скрипты
- Prodamus.XL кастомизация, оформление, скрипты
- Landing page design
- Web development scripts
- Online course marketing

MATERIALS:
${allArticles.slice(0, 30).map((a, i) => `
${i + 1}. ${a.type === 'video' ? 'VIDEO' : 'ARTICLE'} ${a.title}
Source: ${a.source}
Link: ${a.link}
Summary: ${a.snippet}
`).join('\n')}

Create Telegram post (max 2000 chars):

DIGEST: GetCourse, Sales & Automation

For each material:
- Emoji
- Title
- 2-3 sentences: main idea and practical value
- Link

Add at the end:
Main insight of the day - one practical tip

If nothing relevant - write: "No relevant materials today. Try /search command"

Use emojis, be specific.`;

    const digestResult = await model.generateContent(digestPrompt);
    const digest = digestResult.response.text();
    
    await bot.sendMessage(CHANNEL_ID, digest, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    
    console.log('Digest published!');
    
    try {
      const topArticles = allArticles.slice(0, 3);
      
      if (topArticles.length > 0) {
        console.log('Saving to Google Sheets...');
        
        for (let i = 0; i < topArticles.length; i++) {
          const article = topArticles[i];
          
          let category = 'General';
          const titleLower = article.title.toLowerCase();
          
          if (titleLower.includes('getcourse')) {
            category = 'GetCourse';
          } else if (titleLower.includes('prodamus')) {
            category = 'Prodamus';
          } else if (titleLower.includes('landing') || titleLower.includes('лендинг') || titleLower.includes('tilda')) {
            category = 'Landing';
          } else if (titleLower.includes('script') || titleLower.includes('скрипт') || titleLower.includes('javascript')) {
            category = 'Scripts';
          } else if (article.type === 'video') {
            category = 'Video';
          } else {
            category = 'Marketing';
          }
          
          await addToSheet({
            date: new Date().toLocaleDateString('ru-RU'),
            source: article.source,
            title: article.title,
            url: article.link,
            keywords: 'getcourse, automation, online school',
            category: category,
            analysis: article.snippet.substring(0, 200),
            idea: 'Study and apply in project'
          });
          
          console.log(`Saved ${i + 1}/${topArticles.length}`);
        }
        
        console.log('Data saved to Google Sheets!');
      }
      
    } catch (error) {
      console.log(`Error saving to Sheets: ${error.message}`);
    }
    
  } catch (error) {
    console.error('Error in dailyDigest:', error.message);
    try {
      await bot.sendMessage(CHANNEL_ID, 'Error creating digest. Will try later.');
    } catch (e) {
      console.error('Cannot send error message');
    }
  }
}

async function generateIdeas() {
  console.log('Generating ideas...');
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `You are a content strategist and expert in online school automation.

Channel topics:
- GetCourse automation, кастомизация, оформление, скрипты
- Prodamus.XL кастомизация, оформление, скрипты
- Landing page design
- JavaScript scripts for platforms
- Sales funnels

Generate 5 content ideas for next week:

For each idea:
1. Title (catchy, with numbers)
2. Format (article/video/checklist/case study)
3. Content structure (3-5 key blocks)
4. Practical value (specific result)
5. Difficulty (beginner/medium/advanced)
6. Engagement score (1-10)

Ideas should be:
- Practical with specific instructions
- About modern tools 2026
- Solving real audience pain points
- Focused on automation and sales increase

Format as Telegram post with emojis.`;

    const result = await model.generateContent(prompt);
    const ideas = result.response.text();
    
    await bot.sendMessage(CHANNEL_ID, `CONTENT IDEAS FOR THE WEEK\n\n${ideas}`, {
      parse_mode: 'Markdown'
    });
    
    console.log('Ideas published!');
    
  } catch (error) {
    console.error('Error in generateIdeas:', error.message);
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `Hi! I am AI assistant for GetCourse automation, Prodamus and landing pages.

Commands:
/digest - get digest now
/ideas - generate 5 content ideas
/analyze [URL] - analyze article or landing
/search [word] - search in knowledge base
/stats - database statistics

Automatic:
- Daily at 9:00 - digest about GetCourse and automation
- Every Monday 10:00 - content ideas for the week
- Everything saved to Google Sheets

Topics:
• GetCourse and Prodamus.XL automation
• Landing page customization
• Scripts for online platforms`
  );
});

bot.onText(/\/digest/, async (msg) => {
  await bot.sendMessage(msg.chat.id, 'Creating digest...');
  await dailyDigest();
  await bot.sendMessage(msg.chat.id, 'Done! Check the channel.');
});

bot.onText(/\/ideas/, async (msg) => {
  await bot.sendMessage(msg.chat.id, 'Generating ideas...');
  await generateIdeas();
  await bot.sendMessage(msg.chat.id, 'Done! Check the channel.');
});

bot.onText(/\/analyze (.+)/, async (msg, match) => {
  const url = match[1];
  await bot.sendMessage(msg.chat.id, 'Analyzing...');
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `Analyze this material as GetCourse and web development expert: ${url}

Extract and structure:

1. Main topic and essence (2-3 sentences)
2. Key technologies/tools mentioned
3. Practical value - what can be applied in GetCourse/Prodamus
4. Implementation difficulty (beginner/medium/advanced)
5. Adaptation ideas for your project
6. Keywords for cataloging (7-10 tags)

Format as structured Telegram text with emojis.`;

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
    await bot.sendMessage(msg.chat.id, 'Analysis error: ' + error.message);
  }
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const keyword = match[1];
  await bot.sendMessage(msg.chat.id, `Searching: "${keyword}"...`);
  
  try {
    const results = await searchInSheet(keyword);
    
    if (results.length === 0) {
      await bot.sendMessage(msg.chat.id, 
        `Nothing found for "${keyword}".\n\nTry: getcourse, prodamus, landing, script`
      );
      return;
    }
    
    let response = `Found materials: ${results.length}\n\n`;
    
    results.slice(0, 5).forEach((row, i) => {
      response += `${i + 1}. ${row[2]}\n`;
      response += `Category: ${row[5]}\n`;
      response += `${row[3]}\n\n`;
    });
    
    if (results.length > 5) {
      response += `...and ${results.length - 5} more. Refine your search.`;
    }
    
    await bot.sendMessage(msg.chat.id, response);
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, 'Search error: ' + error.message);
  }
});

bot.onText(/\/stats/, async (msg) => {
  await bot.sendMessage(msg.chat.id, 'Getting statistics...');
  
  try {
    const allData = await getFromSheet();
    
    if (allData.length === 0) {
      await bot.sendMessage(msg.chat.id, 'Database is empty. Run /digest to collect materials.');
      return;
    }
    
    const categories = {};
    const sources = {};
    
    allData.forEach(row => {
      const category = row[5] || 'No category';
      const source = row[1] || 'Unknown';
      
      categories[category] = (categories[category] || 0) + 1;
      sources[source] = (sources[source] || 0) + 1;
    });
    
    let stats = `DATABASE STATISTICS\n\n`;
    stats += `Total materials: ${allData.length}\n\n`;
    
    stats += `By categories:\n`;
    Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        stats += `  - ${cat}: ${count}\n`;
      });
    
    stats += `\nBy sources:\n`;
    Object.entries(sources)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([src, count]) => {
        stats += `  - ${src}: ${count}\n`;
      });
    
    await bot.sendMessage(msg.chat.id, stats);
    
  } catch (error) {
    await bot.sendMessage(msg.chat.id, 'Statistics error: ' + error.message);
  }
});

cron.schedule('0 9 * * *', () => {
  console.log('Time for digest!');
  dailyDigest();
}, {
  timezone: "Asia/Yakutsk"
});

cron.schedule('0 10 * * 1', () => {
  console.log('Generating weekly ideas!');
  generateIdeas();
}, {
  timezone: "Asia/Yakutsk"
});

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('GetCourse Bot is running! Content aggregation active.');
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
  console.log(`Server running on port ${PORT}`);
  
  bot.setWebHook(WEBHOOK_URL)
    .then(() => {
      console.log('✅ Webhook set to:', WEBHOOK_URL);
      console.log('🤖 Bot fully started!');
      console.log('📅 Schedule:');
      console.log('   - Digest: daily at 9:00');
      console.log('   - Ideas: every Monday at 10:00');
      console.log('🎯 Topics: GetCourse, Prodamus, landing pages, automation');
    })
    .catch((err) => {
      console.error('❌ Webhook error:', err.message);
    });
});
