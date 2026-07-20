// Hive brand mark — a honeycomb "flower of 7" (six cream cells around a dark
// honey core on an amber tile). Kept in lockstep with the desktop app icon
// (desktop/assets/hive-icon.svg) and the browser favicon (public/favicon.svg).
export function HiveMark({ size = 32, className = '', title = 'Hive' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id="hm-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FBBF24" />
          <stop offset="0.55" stopColor="#F59E0B" />
          <stop offset="1" stopColor="#D97706" />
        </linearGradient>
        <linearGradient id="hm-cell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFDF7" />
          <stop offset="1" stopColor="#FCE8B6" />
        </linearGradient>
        <linearGradient id="hm-core" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#B45309" />
          <stop offset="1" stopColor="#7C3A06" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#hm-bg)" />
      <path d="M38.7,28.1L32.0,24.3L25.3,28.1L25.3,35.9L32.0,39.7L38.7,35.9Z" fill="url(#hm-core)" />
      <path d="M53.6,28.1L46.9,24.3L40.2,28.1L40.2,35.9L46.9,39.7L53.6,35.9Z" fill="url(#hm-cell)" />
      <path d="M23.8,28.1L17.1,24.3L10.4,28.1L10.4,35.9L17.1,39.7L23.8,35.9Z" fill="url(#hm-cell)" />
      <path d="M46.2,15.2L39.4,11.4L32.7,15.2L32.7,23.0L39.4,26.8L46.2,23.0Z" fill="url(#hm-cell)" />
      <path d="M31.3,15.2L24.6,11.4L17.8,15.2L17.8,23.0L24.6,26.8L31.3,23.0Z" fill="url(#hm-cell)" />
      <path d="M46.2,41.0L39.4,37.2L32.7,41.0L32.7,48.8L39.4,52.6L46.2,48.8Z" fill="url(#hm-cell)" />
      <path d="M31.3,41.0L24.6,37.2L17.8,41.0L17.8,48.8L24.6,52.6L31.3,48.8Z" fill="url(#hm-cell)" />
    </svg>
  );
}
