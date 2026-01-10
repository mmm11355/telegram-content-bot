const axios = require('axios');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// ========== КЛЮЧЕВЫЕ СЛОВА ДЛЯ ПОИСКА ==========
const YOUTUBE_KEYWORDS = [
  // GetCourse
  'GetCourse автоматизация',
  'GetCourse кастомизация',
  'личный кабинет GetCourse',
  
  // Prodamus
  'Prodamus XL',
  'Prodamus интеграция',
  
  // Онлайн-школы
  'онлайн-школа создание',
  'образовательная платформа',
  
  // Лендинги и дизайн
  'лендинг на Tilda',
  'продающий лендинг',
  
  // Автоматизация
  'webhook интеграция',
  'JavaScript для сайта',
  'API автоматизация',
  'чат-бот Telegram'
];

// ========== ПОИСК ВИДЕО НА YOUTUBE ==========
async function searchYouTubeVideos(days = 7) {
  if (!YOUTUBE_API_KEY) {
    console.log('⚠️ YouTube API ключ не найден. Пропускаем YouTube.');
    return [];
  }
  
  const videos = [];
  const publishedAfter = new Date();
  publishedAfter.setDate(publishedAfter.getDate() - days);
  
  console.log(`\n🎥 ========== ПОИСК НА YOUTUBE ==========`);
  console.log(`📅 Период: последние ${days} дней`);
  console.log(`🔑 Ключевых слов: ${YOUTUBE_KEYWORDS.length}`);
  
  for (const keyword of YOUTUBE_KEYWORDS) {
    try {
      console.log(`🔍 YouTube: "${keyword}"...`);
      
      const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          key: YOUTUBE_API_KEY,
          q: keyword,
          part: 'snippet',
          type: 'video',
          order: 'date', // Сортировка по дате (новые первыми)
          publishedAfter: publishedAfter.toISOString(),
          maxResults: 10, // Максимум 10 видео на запрос
          regionCode: 'RU',
          relevanceLanguage: 'ru',
          videoDefinition: 'any',
          safeSearch: 'none'
        },
        timeout: 15000
      });
      
      if (response.data.items && response.data.items.length > 0) {
        const foundVideos = response.data.items.map(item => ({
          title: item.snippet.title,
          link: `https://www.youtube.com/watch?v=${item.id.videoId}`,
          source: `YouTube: ${keyword}`,
          snippet: item.snippet.description.substring(0, 300),
          type: '🎥 Видео',
          pubDate: item.snippet.publishedAt,
          dateFormatted: new Date(item.snippet.publishedAt).toLocaleDateString('ru-RU'),
          channelTitle: item.snippet.channelTitle,
          thumbnail: item.snippet.thumbnails?.default?.url || ''
        }));
        
        videos.push(...foundVideos);
        console.log(`   ✅ Найдено: ${foundVideos.length} видео`);
      } else {
        console.log(`   ⚠️ Ничего не найдено`);
      }
      
      // Задержка между запросами (чтобы не превысить лимит API)
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      if (error.response?.status === 403) {
        console.log(`   ❌ Лимит API исчерпан или неверный ключ`);
        break; // Прекращаем поиск, если лимит исчерпан
      } else {
        console.log(`   ❌ Ошибка: ${error.response?.data?.error?.message || error.message}`);
      }
    }
  }
  
  // Удаление дубликатов (по ссылке)
  const uniqueVideos = [];
  const seenLinks = new Set();
  
  videos.forEach(video => {
    if (!seenLinks.has(video.link)) {
      seenLinks.add(video.link);
      uniqueVideos.push(video);
    }
  });
  
  console.log(`🎥 YouTube ИТОГО: ${uniqueVideos.length} уникальных видео`);
  console.log(`========================================\n`);
  
  return uniqueVideos;
}

module.exports = { searchYouTubeVideos };
