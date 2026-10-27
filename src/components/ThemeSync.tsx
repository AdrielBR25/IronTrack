import { useEffect } from 'react';
import { useSettings } from '@/hooks/data';

export function ThemeSync() {
  const { theme } = useSettings();
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && (mq?.matches ?? true));
      document.documentElement.classList.toggle('dark', dark);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b0d0c' : '#f7f7f4');
    };
    apply();
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [theme]);
  return null;
}
