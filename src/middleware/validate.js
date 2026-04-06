const sanitizeHtml = require('sanitize-html');

module.exports = {
  validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  sanitize(input) {
    if (!input) return '';
    return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} });
  }
};
