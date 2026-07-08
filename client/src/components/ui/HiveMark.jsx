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
      <rect x="3" y="3" width="58" height="58" rx="14" fill="#20180f" />
      <path
        d="M16 43.5C16 29.3 22.9 18 32 18s16 11.3 16 25.5C48 49 43.5 53 38 53H26c-5.5 0-10-4-10-9.5Z"
        fill="#F59E0B"
      />
      <path
        d="M20.7 32.1c2.6-1.7 6.8-2.8 11.3-2.8s8.7 1.1 11.3 2.8M18.1 39.4c3.3-2.1 8.4-3.4 13.9-3.4s10.6 1.3 13.9 3.4M19 46.4c3.2-1.8 7.9-2.8 13-2.8s9.8 1 13 2.8"
        fill="none"
        stroke="#78350F"
        strokeLinecap="round"
        strokeWidth="3"
        opacity=".58"
      />
      <path
        d="M23.4 23.5c2.3-2.2 5.2-3.5 8.6-3.5s6.3 1.3 8.6 3.5c-2.4 1.1-5.3 1.7-8.6 1.7s-6.2-.6-8.6-1.7Z"
        fill="#FDE68A"
        opacity=".9"
      />
      <ellipse cx="32" cy="44.3" rx="5.7" ry="7" fill="#241204" />
      <path
        d="M24.4 13.6 29 11l4.6 2.6v5.2L29 21.4l-4.6-2.6v-5.2Zm12 0L41 11l4.6 2.6v5.2L41 21.4l-4.6-2.6v-5.2Z"
        fill="#FBBF24"
        stroke="#FEF3C7"
        strokeWidth="1.2"
      />
      <path
        d="M13.6 25.6c2.3-4.1 6.7-5.7 10.7-3.8M50.4 25.6c-2.3-4.1-6.7-5.7-10.7-3.8"
        fill="none"
        stroke="#FEF3C7"
        strokeLinecap="round"
        strokeWidth="3"
        opacity=".7"
      />
    </svg>
  );
}
