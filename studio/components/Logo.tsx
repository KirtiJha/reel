export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-label="Reel" role="img">
      <defs>
        <linearGradient id="rg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6d8bff" />
          <stop offset="1" stopColor="#7cf3c4" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#rg)" />
      <g fill="#0b0d12" fillOpacity="0.82">
        <rect x="5" y="8" width="3" height="4" rx="1" />
        <rect x="5" y="16.7" width="3" height="4" rx="1" />
        <rect x="5" y="25.3" width="3" height="4" rx="1" />
        <rect x="5" y="34" width="3" height="4" rx="1" />
        <rect x="40" y="8" width="3" height="4" rx="1" />
        <rect x="40" y="16.7" width="3" height="4" rx="1" />
        <rect x="40" y="25.3" width="3" height="4" rx="1" />
        <rect x="40" y="34" width="3" height="4" rx="1" />
      </g>
      <path d="M20 15.5 L34 24 L20 32.5 Z" fill="#0b0d12" fillOpacity="0.9" />
    </svg>
  );
}
