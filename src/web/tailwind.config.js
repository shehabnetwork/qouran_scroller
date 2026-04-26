/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts,scss}'],
  theme: {
    extend: {
      fontFamily: {
        menu: ['"Reem Kufi"', 'Tahoma', 'Arial', 'sans-serif'],
        quran: ['"Amiri Quran"', '"Scheherazade New"', '"Noto Naskh Arabic"', 'serif'],
      },
      boxShadow: {
        soft: '0 20px 60px rgba(15, 23, 42, 0.08)',
        drawer: '-24px 0 56px rgba(15, 23, 42, 0.18)',
      },
    },
  },
  plugins: [],
};
