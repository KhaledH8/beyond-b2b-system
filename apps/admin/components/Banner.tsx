import type { ReactNode } from 'react';

export type BannerVariant = 'info' | 'warning' | 'danger';

export interface BannerProps {
  variant?: BannerVariant;
  children: ReactNode;
  className?: string;
}

const variantClasses: Record<BannerVariant, string> = {
  info: 'bg-blue-50 border-blue-300 text-blue-900',
  warning: 'bg-yellow-50 border-yellow-400 text-yellow-900',
  danger: 'bg-red-50 border-red-400 text-red-900',
};

const variantLabels: Record<BannerVariant, string> = {
  info: 'Info',
  warning: 'Warning',
  danger: 'Danger',
};

export function Banner({
  variant = 'info',
  children,
  className = '',
}: BannerProps) {
  const isAlert = variant === 'warning' || variant === 'danger';
  return (
    <div
      role={isAlert ? 'alert' : 'status'}
      aria-label={variantLabels[variant]}
      className={[
        'rounded border px-4 py-3 text-sm',
        variantClasses[variant],
        className,
      ]
        .join(' ')
        .trim()}
    >
      {children}
    </div>
  );
}
