/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f5f5ff",
          100: "#ebebff",
          200: "#d4d1ff",
          300: "#b8b3ff",
          400: "#a8a3ff",
          500: "#958dff",
          600: "#7b72e8",
          700: "#646cac",
          800: "#4a4f7a",
          900: "#2a2b41",
        },
      },
    },
  },
  plugins: [],
}
