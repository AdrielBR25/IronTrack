import animate from "tailwindcss-animate";
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk Variable"', '"Inter Variable"', 'system-ui', 'sans-serif'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        warn: 'hsl(var(--warn))',
      },
      // Fase 08: `/12` era usado nos fundos suaves (atributos, ícones) mas não existia na escala: os fundos não apareciam.
      opacity: { 12: '0.12' },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 4px)', sm: 'calc(var(--radius) - 8px)', xl: 'calc(var(--radius) + 4px)', '2xl': 'calc(var(--radius) + 10px)' },
      keyframes: {
        'pulse-ring': { '0%,100%': { boxShadow: '0 0 0 0 hsl(var(--primary) / 0.5)' }, '50%': { boxShadow: '0 0 0 10px hsl(var(--primary) / 0)' } },
        // Fase 03: linha de "leitura" sobre a foto durante a análise.
        scan: { '0%': { top: '-10%' }, '100%': { top: '105%' } },
      },
      animation: { 'pulse-ring': 'pulse-ring 1.6s ease-in-out infinite', scan: 'scan 1.8s cubic-bezier(.45,0,.55,1) infinite alternate' },
    },
  },
  plugins: [animate],
};
