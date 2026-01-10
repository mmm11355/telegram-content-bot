const axios = require('axios');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Ключевые слова для поиска
const YOUTUBE_KEYWORDS = [
  'GetCourse автоматизация',
  'Prodamus XL',
  'онлайн-школа создание',
  'личный кабинет GetCourse',
  'лендинг на Tilda',
  'webhook интеграция',
  'JavaScript для сайта'
];

async function searchYouTubeVideos(days = 7) {
  const videos = [];
  const publishedAfter = new Date();
  publishedAfter.setDate(publishedAfter.getDate() - days);
  
  for (const keyword of YOUTUBE_KEYWORDS) {
    try {
      console.log(`🔍 YouTube поиск: "${keyword}"...`);
      
      const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          key: YOUTUBE_API_KEY,
          q: keyword,
          part: 'snippet',
          type: 'video',
          order: 'date', // Сортировка по дате (новые первыми)
          publishedAfter: publishedAfter.toISOString(),
          maxResults: 10,
          regionCode: 'RU',
          relevanceLanguage: 'ru',
          videoDefinition: 'any',
          safeSearch: 'none'
        },
        timeout: 10000
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
          thumbnail: item.snippet.thumbnails.default.url
        }));
        
        videos.push(...foundVideos);
        console.log(`✅ YouTube "${keyword}": ${foundVideos.length} видео`);
      }
      
      // Задержка между запросами (чтобы не превысить лимит API)
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.log(`❌ YouTube ошибка "${keyword}":`, error.response?.data?.error?.message || error.message);
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
  
  console.log(`🎥 YouTube: найдено ${uniqueVideos.length} уникальных видео`);
  
  return uniqueVideos;
}

module.exports = { searchYouTubeVideos };
