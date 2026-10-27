export function LogoMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="16" fill="hsl(var(--primary))" />
      <g fill="hsl(var(--primary-foreground))">
        <rect x="10" y="22" width="7" height="20" rx="2" />
        <rect x="18" y="17" width="7" height="30" rx="2" />
        <rect x="39" y="17" width="7" height="30" rx="2" />
        <rect x="47" y="22" width="7" height="20" rx="2" />
        <rect x="25" y="29" width="14" height="6" rx="1.5" />
      </g>
    </svg>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <span className="font-display text-xl font-bold tracking-tight">
        Iron<span className="text-primary">Track</span>
      </span>
    </div>
  );
}
