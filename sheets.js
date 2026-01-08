const { google } = require('googleapis');

// Авторизация через JSON из переменных окружения
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Функция добавления данных в таблицу
async function addToSheet(data) {
  try {
    const { date, source, title, url, keywords, category, analysis, idea } = data;
    
    const values = [[
      date || new Date().toLocaleDateString('ru-RU'),
      source || '',
      title || '',
      url || '',
      keywords || '',
      category || '',
      analysis || '',
      idea || ''
    ]];
    
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Лист1!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });
    
    console.log('✅ Данные добавлены в таблицу:', response.data.updates.updatedRows);
    return response.data;
    
  } catch (error) {
    console.error('❌ Ошибка записи в таблицу:', error.message);
    throw error;
  }
}

// Функция чтения данных
async function getFromSheet(range = 'Лист1!A2:H') {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: range
    });
    
    return response.data.values || [];
    
  } catch (error) {
    console.error('❌ Ошибка чтения таблицы:', error.message);
    throw error;
  }
}

// Функция поиска
async function searchInSheet(keyword) {
  try {
    const data = await getFromSheet();
    
    const results = data.filter(row => {
      const text = row.join(' ').toLowerCase();
      return text.includes(keyword.toLowerCase());
    });
    
    return results;
    
  } catch (error) {
    console.error('❌ Ошибка поиска:', error.message);
    throw error;
  }
}

module.exports = {
  addToSheet,
  getFromSheet,
  searchInSheet
};
