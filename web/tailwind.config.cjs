const path = require('path');
/** Light, warm and clean, with a light touch of WoW. Colors are CSS variables so dark mode is one switch. */
module.exports = {
  content: [path.join(__dirname, 'index.html'), path.join(__dirname, 'src/**/*.{ts,tsx}')],
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        page: 'rgb(var(--page) / <alpha-value>)',
        card: 'rgb(var(--card) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        gold: 'rgb(var(--gold) / <alpha-value>)',
        good: 'rgb(var(--good) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        bad: 'rgb(var(--bad) / <alpha-value>)',
        alliance: 'rgb(var(--alliance) / <alpha-value>)',
        blackwater: 'rgb(var(--blackwater) / <alpha-value>)',
      },
      fontFamily: {
        display: ['Cinzel', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: { card: '0 1px 2px rgb(60 45 20 / 0.06), 0 4px 16px rgb(60 45 20 / 0.05)' },
    },
  },
  plugins: [],
};
