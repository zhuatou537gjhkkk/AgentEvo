/** @type {import('tailwindcss').Config} */
export default {
    darkMode: 'class',
    content: ["./index.html", "./src/**/*.{js,jsx}"],
    theme: {
        extend: {
            colors: {
                brand: {
                    start: '#6366f1',
                    mid: '#8b5cf6',
                    end: '#d946ef',
                },
            },
            backgroundImage: {
                'brand-gradient': 'linear-gradient(135deg, #6366f1, #8b5cf6, #d946ef)',
            },
            boxShadow: {
                glass: '0 8px 32px rgba(99, 102, 241, 0.10)',
                'glass-lg': '0 16px 48px rgba(99, 102, 241, 0.16)',
            },
            keyframes: {
                'blob-drift': {
                    '0%, 100%': { transform: 'translate3d(0,0,0) scale(1)' },
                    '33%': { transform: 'translate3d(40px,-30px,0) scale(1.08)' },
                    '66%': { transform: 'translate3d(-30px,24px,0) scale(0.96)' },
                },
                'gradient-flow': {
                    '0%': { backgroundPosition: '0% 50%' },
                    '50%': { backgroundPosition: '100% 50%' },
                    '100%': { backgroundPosition: '0% 50%' },
                },
            },
            animation: {
                'blob-drift': 'blob-drift 20s ease-in-out infinite',
                'gradient-flow': 'gradient-flow 4s ease infinite',
            },
        },
    },
    plugins: []
};
