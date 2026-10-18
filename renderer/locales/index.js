// Loads every translation into I18n's dictionaries, for the main process and
// tests. The window loads the same files with <script> tags.
for (const id of ['fr', 'de', 'it', 'pt-BR', 'ja', 'ko']) {
  try {
    require(`./${id}.js`);
  } catch {
    // A missing translation falls back to English.
  }
}
module.exports = require('../i18n').dictionaries;
